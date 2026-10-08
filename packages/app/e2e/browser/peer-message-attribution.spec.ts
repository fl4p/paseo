import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("Peer message attribution", () => {
  test("names the session a message came from and offers no rewind on it", async ({
    page,
  }, testInfo) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: `peer-message-${testInfo.workerIndex}-`,
      title: "Peer message attribution",
    });
    try {
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectComposerVisible(page);
      await expectAgentIdle(page);

      await submitMessage(page, "deliver peer message from dragino");

      const peerMessage = page
        .getByTestId("user-message")
        .filter({ hasText: "I changed things under you on farmgw." });
      await expect(peerMessage.getByTestId("user-message-origin")).toHaveText("From dragino");
      await expect(peerMessage.getByTestId("user-message-timestamp")).toBeAttached();

      // Collapsed by default: one line of preview, the rest hidden until asked for.
      await expect(peerMessage.getByTestId("user-message-origin-preview")).toHaveText(
        "I changed things under you on farmgw.",
      );
      await expect(peerMessage.getByText("/etc/farmgw", { exact: false })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("peer-message-collapsed.png") });
      testInfo.attach("collapsed peer message", {
        path: testInfo.outputPath("peer-message-collapsed.png"),
      });
      await peerMessage.getByTestId("user-message-origin-toggle").click();
      await expect(peerMessage.getByText("/etc/farmgw", { exact: false })).toBeVisible();
      await expect(peerMessage.getByTestId("user-message-origin-preview")).toHaveCount(0);
      await peerMessage.hover();
      await expect(peerMessage.getByRole("button", { name: /rewind/i })).toHaveCount(0);

      await expectAgentIdle(page);
      await page.screenshot({ path: testInfo.outputPath("peer-message.png") });
      testInfo.attach("peer message", { path: testInfo.outputPath("peer-message.png") });
    } finally {
      await agent.cleanup();
    }
  });
});
