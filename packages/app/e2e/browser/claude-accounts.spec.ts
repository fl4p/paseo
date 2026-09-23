import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { test as base, expect } from "../support/fixtures";
import { launchAgent, cleanupRewindFlow } from "../support/helpers/rewind-flow";
import { composerLocator } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

const test = base.extend<{}, { accountRoot: string }>({
  accountRoot: [
    async ({ browserName }, provide) => {
      void browserName;
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-account-browser-"));
      try {
        await provide(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonConfig: [
    async ({ accountRoot }, provide) => {
      await provide({
        agents: {
          providers: {
            claude: {
              params: {
                accounts: {
                  work: { label: "Work account", configDir: path.join(accountRoot, "work") },
                  personal: {
                    label: "Personal account",
                    configDir: path.join(accountRoot, "personal"),
                  },
                },
              },
            },
          },
        },
      });
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ accountRoot }, provide) => {
      await provide({ CLAUDE_CONFIG_DIR: path.join(accountRoot, "default") });
    },
    { scope: "worker" },
  ],
});

const EnvelopeSchema = z
  .object({
    type: z.literal("session"),
    message: z.object({ type: z.string(), value: z.unknown().optional() }).passthrough(),
  })
  .passthrough();

test("selects an account, persists a switch, and shows pending and rejected switches", async ({
  page,
  accountRoot,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("@paseo:create-agent-preferences")) {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({
          provider: "claude",
          providerPreferences: { claude: { model: "haiku" } },
        }),
      );
    }
  });
  let rejectNext = false;
  const pendingRequests: Array<() => void> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const parsed = EnvelopeSchema.safeParse(JSON.parse(String(raw)));
      if (parsed.success && parsed.data.message.type === "set_agent_feature_request") {
        const envelope = parsed.data;
        if (rejectNext) envelope.message.value = "removed-account";
        pendingRequests.push(server.send.bind(server, JSON.stringify(envelope)));
      } else {
        server.send(raw);
      }
    });
  });
  const cwd = await mkdtemp(path.join(accountRoot, "workspace-"));
  const handle = await launchAgent({
    page,
    provider: "claude",
    cwd,
    mode: "full-access",
    providerConfig: { featureValues: { account: "work" } },
  });
  try {
    const compact = (page.viewportSize()?.width ?? 1280) < 768;
    if (compact) await page.getByTestId("combined-model-selector").click();
    const controls = page.getByTestId(
      compact ? "agent-controls-combined-sheet-controls" : "message-input-root",
    );
    const selector = controls.getByTestId("agent-feature-account").filter({ visible: true });
    await expect(selector).toContainText("Work account");
    await selector.click();
    await page.getByRole("button", { name: "Personal account", exact: true }).click();
    await expect(controls.getByText("Applying setting…", { exact: true })).toBeVisible();
    await expect(selector).toBeDisabled();
    await expect.poll(() => pendingRequests.length).toBe(1);
    const release = pendingRequests.shift();
    if (!release) throw new Error("Account request was not sent");
    release();
    await expect(selector).toContainText("Personal account");
    await page.reload();
    if (compact) await page.getByTestId("combined-model-selector").click();
    await expect(selector).toContainText("Personal account");

    rejectNext = true;
    await selector.click();
    await page.getByRole("button", { name: "Work account", exact: true }).click();
    await expect.poll(() => pendingRequests.length).toBe(1);
    const reject = pendingRequests.shift();
    if (!reject) throw new Error("Account request was not sent");
    reject();
    await expect(
      controls.getByRole("alert").filter({ hasText: "Unknown Claude account: removed-account" }),
    ).toBeVisible();
    await expect(selector).toContainText("Personal account");
    await expect(selector).toBeEnabled();
    await expect(page.getByRole("button", { name: "Work account", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("account-switch-error.png") });

    await page.reload();
    const composer = composerLocator(page);
    await expect(composer).toBeEditable();
    await composer.fill("/clear");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(async () =>
        Boolean((await handle.client.fetchAgent({ agentId: handle.agentId }))?.agent.archivedAt),
      )
      .toBe(true);
    if (compact) await page.getByTestId("combined-model-selector").click();
    const draftSelector = page.getByTestId("agent-feature-account").filter({ visible: true });
    await expect(draftSelector).toContainText("Personal account");
    await draftSelector.click();
    await page.getByRole("button", { name: "Work account", exact: true }).click();
    await expect(draftSelector).toContainText("Work account");
    // Draft selection is local; it must not mutate the preceding live conversation.
    expect(pendingRequests).toHaveLength(0);
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});
