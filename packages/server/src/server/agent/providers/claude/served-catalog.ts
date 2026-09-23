import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";
import {
  buildClaudeEffortThinkingOptions,
  isClaudeCodeVersionSufficient,
} from "./model-manifest.js";

/**
 * Claude Code no longer ships its picker list only in the binary: it fetches a per-account
 * "served catalog" and caches it under `<configDir>/cache/model-catalog`. Reading that cache is
 * how a model Anthropic released after this Paseo build still shows up in the picker — the
 * compiled manifest stays the curated source for labels, 1M variants and capability flags, and
 * the served rows only add what the manifest has never heard of.
 *
 * The cache is written by Claude Code, so a brand-new model appears here only once the CLI has
 * refreshed it (it does so roughly hourly while running).
 */
const SERVED_CATALOG_DIR_SEGMENTS = ["cache", "model-catalog"] as const;

/** Per-surface cache files are `<uuid>-<hash>-<surface>.json`; `cc` is the Claude Code surface. */
const SERVED_CATALOG_FILE_SUFFIX = "-cc.json";

const SERVED_CATALOG_SURFACE = "cc";

/**
 * Cache files are ~9 kB. The cap is not a security boundary — the file is as trusted as the rest
 * of the Claude config — it just stops a symlink to something unbounded from being read into
 * memory during a catalog refresh.
 */
const SERVED_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

export function resolveClaudeConfigDir(configDir?: string): string {
  return configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

interface ServedCatalogModel {
  id: string;
  name?: string;
  description?: string;
  minClaudeCodeVersion?: string;
  effortOptionIds?: string[];
  supportsFastMode?: boolean;
}

/**
 * Served model IDs that declared fast mode, from the last catalog read.
 *
 * Fast mode is answered synchronously from a model ID alone (a session's `features` getter), so
 * the served answer cannot be fetched on demand and is snapshotted here instead. Empty until the
 * first catalog read, and reset by every read including a failed one: a model that briefly loses
 * the toggle is a much smaller error than one that offers a flag Claude Code will reject.
 */
let servedFastModeModelIds: ReadonlySet<string> = new Set();

/**
 * Whether the served catalog says this model supports fast mode. Callers must OR this with the
 * manifest answer — the manifest, not the cache, is the source of truth for the models it ships.
 */
export function claudeServedModelSupportsFastMode(modelId: string | null | undefined): boolean {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  return trimmed.length > 0 && servedFastModeModelIds.has(trimmed);
}

/**
 * Read the models from Claude Code's most recently fetched served catalog.
 *
 * Returns an empty list for every failure mode (no cache, unreadable, malformed, another
 * surface): the caller falls back to the compiled manifest, which is always a valid catalog.
 */
export async function readClaudeServedCatalogModels(
  logger: Logger,
  configDir?: string,
  claudeCodeVersion?: string,
): Promise<AgentModelDefinition[]> {
  const resolvedConfigDir = resolveClaudeConfigDir(configDir);
  const catalogDir = path.join(resolvedConfigDir, ...SERVED_CATALOG_DIR_SEGMENTS);

  let entries: string[];
  try {
    entries = await fs.readdir(catalogDir);
  } catch (error) {
    logger.debug({ err: error, catalogDir }, "No Claude served model catalog cache");
    servedFastModeModelIds = new Set();
    return [];
  }

  // Cache files are named `<organizationUuid>-<hash>-<surface>.json`, and one machine can hold a
  // catalog per account. Whoever Claude Code is signed in as decides which one is the truth;
  // the newest fetch is only a fallback for when we cannot tell.
  const organizationUuid = await readActiveOrganizationUuid(logger, resolvedConfigDir);
  const accountEntries = organizationUuid
    ? entries.filter((entry) => entry.startsWith(`${organizationUuid}-`))
    : [];

  const newest =
    (accountEntries.length > 0
      ? await readNewestServedCatalog(logger, catalogDir, accountEntries)
      : undefined) ?? (await readNewestServedCatalog(logger, catalogDir, entries));
  if (!newest) {
    servedFastModeModelIds = new Set();
    return [];
  }

  const definitions: AgentModelDefinition[] = [];
  const fastModeModelIds = new Set<string>();
  for (const model of newest) {
    if (!isClaudeCodeVersionSufficient(model.minClaudeCodeVersion, claudeCodeVersion)) {
      continue;
    }
    if (model.supportsFastMode === true) {
      fastModeModelIds.add(model.id);
    }
    definitions.push(toModelDefinition(model));
  }
  servedFastModeModelIds = fastModeModelIds;
  return definitions;
}

/**
 * The organization UUID Claude Code is currently signed in as, which prefixes its cache files.
 */
async function readActiveOrganizationUuid(
  logger: Logger,
  resolvedConfigDir: string,
): Promise<string | undefined> {
  // With CLAUDE_CONFIG_DIR set, that directory is the configuration home and holds the state
  // file; by default it is ~/.claude and the state file is its sibling ~/.claude.json.
  const statePaths = [
    path.join(resolvedConfigDir, ".claude.json"),
    path.join(path.dirname(resolvedConfigDir), ".claude.json"),
  ];

  for (const statePath of statePaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch (error) {
      logger.debug({ err: error, statePath }, "Failed to read the active Claude account");
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) {
      continue;
    }
    const organizationUuid = parsed.oauthAccount.organizationUuid;
    if (typeof organizationUuid === "string" && organizationUuid.length > 0) {
      return organizationUuid;
    }
  }
  return undefined;
}

async function readNewestServedCatalog(
  logger: Logger,
  catalogDir: string,
  entries: string[],
): Promise<ServedCatalogModel[] | undefined> {
  let newestModels: ServedCatalogModel[] | undefined;
  let newestFetchedAt = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (!entry.endsWith(SERVED_CATALOG_FILE_SUFFIX)) {
      continue;
    }
    const filePath = path.join(catalogDir, entry);

    let contents: string;
    try {
      // lstat, so a symlink is skipped rather than followed to something unbounded.
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.size > SERVED_CATALOG_MAX_BYTES) {
        logger.debug({ filePath, size: stats.size }, "Skipping Claude served model catalog entry");
        continue;
      }
      contents = await fs.readFile(filePath, "utf8");
    } catch (error) {
      logger.debug({ err: error, filePath }, "Failed to read Claude served model catalog");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      // Deliberately not the parser's message: it quotes the offending input back at us.
      logger.debug({ filePath }, "Claude served model catalog is not valid JSON");
      continue;
    }

    const models = parseServedCatalog(parsed);
    if (!models) {
      logger.debug({ filePath }, "Claude served model catalog has an unexpected shape");
      continue;
    }

    // Several accounts can have cached a catalog; the newest fetch is the one the user last used.
    const fetchedAt =
      isRecord(parsed) && typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
    if (fetchedAt >= newestFetchedAt) {
      newestFetchedAt = fetchedAt;
      newestModels = models;
    }
  }

  return newestModels;
}

function parseServedCatalog(parsed: unknown): ServedCatalogModel[] | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.catalog)) {
    return undefined;
  }
  const catalog = parsed.catalog;
  if (catalog.surface !== SERVED_CATALOG_SURFACE || !isRecord(catalog.config)) {
    return undefined;
  }
  const rawModels = catalog.config.models;
  if (!Array.isArray(rawModels)) {
    return undefined;
  }

  const models: ServedCatalogModel[] = [];
  for (const rawModel of rawModels) {
    const model = parseServedCatalogModel(rawModel);
    if (model) {
      models.push(model);
    }
  }
  return models;
}

function parseServedCatalogModel(rawModel: unknown): ServedCatalogModel | undefined {
  if (!isRecord(rawModel) || typeof rawModel.id !== "string") {
    return undefined;
  }
  const id = rawModel.id.trim();
  if (id.length === 0) {
    return undefined;
  }

  const model: ServedCatalogModel = { id };
  if (typeof rawModel.name === "string" && rawModel.name.trim().length > 0) {
    model.name = rawModel.name.trim();
  }
  if (typeof rawModel.description === "string" && rawModel.description.trim().length > 0) {
    model.description = rawModel.description.trim();
  }
  if (rawModel.min_claude_code_version !== undefined) {
    // A gate we cannot evaluate is not an absent gate: drop the row rather than offer a model
    // this Claude Code may not accept.
    if (typeof rawModel.min_claude_code_version !== "string") {
      return undefined;
    }
    model.minClaudeCodeVersion = rawModel.min_claude_code_version;
  }

  if (rawModel.fast_mode === true) {
    model.supportsFastMode = true;
  }

  const thinking = rawModel.thinking;
  if (isRecord(thinking) && thinking.type === "effort" && Array.isArray(thinking.effort_options)) {
    model.effortOptionIds = thinking.effort_options.flatMap((option) =>
      isRecord(option) && typeof option.id === "string" ? [option.id] : [],
    );
  }

  return model;
}

function toModelDefinition(model: ServedCatalogModel): AgentModelDefinition {
  const definition: AgentModelDefinition = {
    provider: "claude",
    id: model.id,
    label: model.name ?? model.id,
    description: model.description ?? "From the Claude model catalog",
  };

  const thinkingOptions: AgentSelectOption[] | undefined = model.effortOptionIds
    ? buildClaudeEffortThinkingOptions(model.effortOptionIds)
    : undefined;
  if (thinkingOptions && thinkingOptions.length > 0) {
    definition.thinkingOptions = thinkingOptions;
    const defaultOption = thinkingOptions.find((option) => option.isDefault);
    if (defaultOption) {
      definition.defaultThinkingOptionId = defaultOption.id;
    }
  }

  return definition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
