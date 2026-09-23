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

export function resolveClaudeConfigDir(configDir?: string): string {
  return configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

interface ServedCatalogModel {
  id: string;
  name?: string;
  description?: string;
  minClaudeCodeVersion?: string;
  effortOptionIds?: string[];
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
  const catalogDir = path.join(resolveClaudeConfigDir(configDir), ...SERVED_CATALOG_DIR_SEGMENTS);

  let entries: string[];
  try {
    entries = await fs.readdir(catalogDir);
  } catch (error) {
    logger.debug({ err: error, catalogDir }, "No Claude served model catalog cache");
    return [];
  }

  const newest = await readNewestServedCatalog(logger, catalogDir, entries);
  if (!newest) {
    return [];
  }

  const definitions: AgentModelDefinition[] = [];
  for (const model of newest) {
    if (!isClaudeCodeVersionSufficient(model.minClaudeCodeVersion, claudeCodeVersion)) {
      continue;
    }
    definitions.push(toModelDefinition(model));
  }
  return definitions;
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      logger.debug({ err: error, filePath }, "Failed to read Claude served model catalog");
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
  if (typeof rawModel.min_claude_code_version === "string") {
    model.minClaudeCodeVersion = rawModel.min_claude_code_version;
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
