import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CoverageScanResult } from "./coverage.js";
import type { Inventory } from "./inventory.js";

export type ContextItemType = "memory" | "file" | "diff" | "attachment" | "session" | "tool-result";
export type ContextItemAddedBy = "system" | "agent" | "user";
export type ContextItemValidity = "current" | "stale" | "missing" | "historical" | "unvalidated";

export interface ContextItem {
  id: string;
  type: ContextItemType;
  title: string;
  summary: string;
  source: string;
  included: boolean;
  enabled: boolean;
  pinned: boolean;
  autoAdded: boolean;
  addedBy: ContextItemAddedBy;
  reason: string;
  createdAt: string;
  lastUsedAt: string | null;
  tokensEstimate: number;
  sourceHash: string | null;
  validatedAt: string | null;
  validity: ContextItemValidity;
  content?: string;
  excludedReason?: string;
}

export interface ContextPackInput {
  task: string;
  workspaceRoot: string;
  inventory: Inventory;
  coverage: CoverageScanResult;
  priorityPaths?: string[];
  existingPack?: ContextPack;
}

export interface ContextPack {
  version: 1;
  task: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  coverageStatus: CoverageScanResult["status"];
  budgetTokens: number;
  tokensEstimate: number;
  items: ContextItem[];
}

export interface ContextPackUpdate {
  items?: ContextItem[];
  removeIds?: string[];
  setEnabled?: Array<{ id: string; enabled: boolean }>;
}

const BASE_MEMORY_FILES = ["PROJECT.md", "MODULES.md", "CONVENTIONS.md", "TESTING.md", "MEMORY.md"];
const DEFAULT_CONTEXT_BUDGET_TOKENS = 24000;

export async function createContextPack(input: ContextPackInput): Promise<ContextPack> {
  const createdAt = new Date().toISOString();
  const base = input.existingPack
    ? {
        ...input.existingPack,
        task: input.task,
        coverageStatus: input.coverage.status,
        updatedAt: createdAt
      }
    : {
        version: 1 as const,
        task: input.task,
        createdAt,
        updatedAt: createdAt,
        workspaceRoot: input.workspaceRoot,
        coverageStatus: input.coverage.status,
        budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        tokensEstimate: 0,
        items: []
      };
  const seedItems: ContextItem[] = [];
  seedItems.push(...createCoverageItems(input.coverage, createdAt));
  seedItems.push(...(await createMemoryTrayItems(input.workspaceRoot, createdAt)));
  seedItems.push(...(await createPriorityPathItems(input.workspaceRoot, input.priorityPaths ?? [], input.inventory, createdAt)));

  return normalizeContextPack({
    ...base,
    items: mergeContextItems(base.items, seedItems)
  });
}

export function updateContextPack(pack: ContextPack, update: ContextPackUpdate): ContextPack {
  let items = [...pack.items];
  if (update.removeIds?.length) {
    const removeIds = new Set(update.removeIds);
    items = items.filter((item) => !removeIds.has(item.id));
  }
  if (update.items?.length) {
    items = mergeContextItems(items, update.items);
  }
  if (update.setEnabled?.length) {
    const enabledById = new Map(update.setEnabled.map((item) => [item.id, item.enabled]));
    items = items.map((item) => {
      if (!enabledById.has(item.id)) {
        return item;
      }
      const enabled = Boolean(enabledById.get(item.id));
      return {
        ...item,
        enabled,
        included: enabled
      };
    });
  }
  return normalizeContextPack({
    ...pack,
    updatedAt: new Date().toISOString(),
    items
  });
}

export function createContextItem(input: {
  type: ContextItemType;
  source: string;
  title: string;
  summary: string;
  content?: string;
  enabled?: boolean;
  pinned?: boolean;
  autoAdded?: boolean;
  addedBy?: ContextItemAddedBy;
  reason: string;
  createdAt?: string;
  excludedReason?: string;
  sourceHash?: string | null;
  validity?: ContextItemValidity;
}): ContextItem {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const enabled = input.enabled ?? true;
  const content = input.content;
  return {
    id: contextItemId(input.type, input.source),
    type: input.type,
    title: input.title,
    summary: input.summary,
    source: input.source,
    included: enabled,
    enabled,
    pinned: input.pinned ?? false,
    autoAdded: input.autoAdded ?? input.addedBy !== "user",
    addedBy: input.addedBy ?? "system",
    reason: input.reason,
    createdAt,
    lastUsedAt: null,
    tokensEstimate: estimateTokens(`${input.title}\n${input.summary}\n${content ?? ""}`),
    sourceHash: input.sourceHash ?? (content ? hashText(content) : null),
    validatedAt: input.validity === "historical" ? null : createdAt,
    validity: input.validity ?? (input.excludedReason ? "missing" : content ? "current" : "unvalidated"),
    content,
    excludedReason: input.excludedReason
  };
}

export function enabledContextItems(pack: ContextPack): ContextItem[] {
  return pack.items.filter((item) => item.enabled && !item.excludedReason && item.validity !== "missing" && item.validity !== "stale");
}

export async function revalidateContextPack(workspaceRoot: string, pack: ContextPack): Promise<ContextPack> {
  const validatedAt = new Date().toISOString();
  const items = await Promise.all(pack.items.map((item) => revalidateContextItem(workspaceRoot, item, validatedAt)));
  return normalizeContextPack({
    ...pack,
    updatedAt: validatedAt,
    items
  });
}

function createCoverageItems(coverage: CoverageScanResult, createdAt: string): ContextItem[] {
  const summary =
    coverage.issues.length === 0
      ? `Coverage status is ${coverage.status}; no scan issues were detected.`
      : `Coverage status is ${coverage.status}; ${coverage.issues.length} issue(s) currently affect the workspace.`;
  return [
    createContextItem({
      type: "file",
      title: "Coverage status",
      summary,
      source: ".apeiron/memory/inventory.json",
      enabled: coverage.status !== "ready",
      addedBy: "system",
      reason: "Keep workspace coverage risks visible to the user and the next model call.",
      createdAt,
      content: coverage.issues.length > 0 ? JSON.stringify(coverage.issues.slice(0, 20), null, 2) : undefined,
      validity: "current"
    })
  ];
}

async function createMemoryTrayItems(workspaceRoot: string, createdAt: string): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  for (const fileName of BASE_MEMORY_FILES) {
    const source = `.apeiron/memory/${fileName}`;
    const absolutePath = path.join(workspaceRoot, source);
    if (!existsSync(absolutePath)) {
      items.push(
        createContextItem({
          type: "memory",
          title: fileName,
          summary: "Memory file is missing; warmup should create or repair it.",
          source,
          enabled: false,
          addedBy: "system",
          reason: "Base project memory file is unavailable.",
          createdAt,
          excludedReason: "missing-memory-file"
        })
      );
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    items.push(
      createContextItem({
        type: "memory",
        title: fileName,
        summary: summarizeText(content),
        source,
        enabled: true,
        addedBy: "system",
        reason: "Base project memory starts the session with a thin project map.",
        createdAt,
        content: trimContent(content, 2500)
      })
    );
  }
  return items;
}

async function createPriorityPathItems(
  workspaceRoot: string,
  priorityPaths: string[],
  inventory: Inventory,
  createdAt: string
): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  for (const priorityPath of priorityPaths) {
    const entry = inventory.files[priorityPath];
    const sourceContent = await readOptionalText(path.join(workspaceRoot, ...priorityPath.split("/")));
    items.push(
      createContextItem({
        type: "file",
        title: `Pinned file: ${priorityPath}`,
        summary: entry
          ? `Inventory status=${entry.status}, kind=${entry.kind}, summaryRef=${entry.summaryRef ?? "none"}. ${entry.purpose}`
          : "User-prioritized path is not present in inventory.json.",
        source: priorityPath,
        enabled: Boolean(sourceContent),
        pinned: true,
        autoAdded: false,
        addedBy: "user",
        reason: "User prioritized this path for the current conversation.",
        createdAt,
        content: sourceContent ? trimContent(sourceContent, 6000) : undefined,
        excludedReason: sourceContent ? undefined : "missing-priority-file"
      })
    );
  }
  return items;
}

function mergeContextItems(existing: ContextItem[], incoming: ContextItem[]): ContextItem[] {
  const byId = new Map<string, ContextItem>();
  for (const item of existing) {
    byId.set(item.id, normalizeItem(item));
  }
  for (const item of incoming) {
    const normalized = normalizeItem(item);
    const current = byId.get(normalized.id);
    if (!current) {
      byId.set(normalized.id, normalized);
      continue;
    }
    byId.set(normalized.id, {
      ...current,
      ...normalized,
      enabled: current.pinned ? current.enabled : normalized.enabled,
      included: current.pinned ? current.included : normalized.included,
      pinned: current.pinned || normalized.pinned,
      createdAt: current.createdAt,
      lastUsedAt: current.lastUsedAt
    });
  }
  return Array.from(byId.values()).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt.localeCompare(b.createdAt));
}

function normalizeContextPack(pack: ContextPack): ContextPack {
  const items = pack.items.map(normalizeItem);
  return {
    ...pack,
    items,
    tokensEstimate: items.filter((item) => item.enabled).reduce((total, item) => total + item.tokensEstimate, 0)
  };
}

function normalizeItem(item: ContextItem): ContextItem {
  const enabled = item.enabled ?? item.included ?? true;
  return {
    ...item,
    enabled,
    included: enabled,
    pinned: item.pinned ?? false,
    autoAdded: item.autoAdded ?? item.addedBy !== "user",
    addedBy: item.addedBy ?? "system",
    reason: item.reason ?? "Context item carried forward from session state.",
    createdAt: item.createdAt ?? new Date().toISOString(),
    lastUsedAt: item.lastUsedAt ?? null,
    tokensEstimate: item.tokensEstimate ?? estimateTokens(`${item.title}\n${item.summary}\n${item.content ?? ""}`),
    sourceHash: item.sourceHash ?? (item.content ? hashText(item.content) : null),
    validatedAt: item.validatedAt ?? null,
    validity: item.validity ?? "unvalidated"
  };
}

async function revalidateContextItem(workspaceRoot: string, item: ContextItem, validatedAt: string): Promise<ContextItem> {
  if (item.type === "diff" || item.type === "tool-result" || item.type === "session") {
    return {
      ...item,
      enabled: false,
      included: false,
      validity: "historical",
      validatedAt
    };
  }
  const absolutePath = path.isAbsolute(item.source) ? item.source : path.join(workspaceRoot, ...item.source.split("/"));
  if (!existsSync(absolutePath)) {
    return {
      ...item,
      enabled: false,
      included: false,
      validity: "missing",
      validatedAt,
      excludedReason: item.excludedReason ?? "source-missing"
    };
  }
  if (item.type === "attachment" && item.content?.startsWith("[image attachment:")) {
    return {
      ...item,
      validatedAt,
      validity: "current",
      excludedReason: undefined
    };
  }
  const content = await fs.readFile(absolutePath, "utf8");
  const sourceHash = hashText(content);
  const stale = Boolean(item.sourceHash && item.sourceHash !== sourceHash);
  return {
    ...item,
    content: stale ? item.content : trimContent(content, item.type === "memory" ? 2500 : 8000),
    summary: stale ? item.summary : summarizeText(content),
    enabled: stale ? false : item.enabled,
    included: stale ? false : item.included,
    sourceHash,
    validatedAt,
    validity: stale ? "stale" : "current",
    excludedReason: stale ? "source-changed" : undefined,
    tokensEstimate: stale ? item.tokensEstimate : estimateTokens(`${item.title}\n${summarizeText(content)}\n${trimContent(content, item.type === "memory" ? 2500 : 8000)}`)
  };
}

function contextItemId(type: ContextItemType, source: string): string {
  return `${type}:${source}`;
}

function summarizeText(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 497)}...`;
}

async function readOptionalText(absolutePath: string): Promise<string | null> {
  if (!existsSync(absolutePath)) {
    return null;
  }
  return await fs.readFile(absolutePath, "utf8");
}

function trimContent(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function hashText(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
