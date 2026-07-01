import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectCoverage } from "./coverage.js";
import {
  classifyPath,
  createDiscoveredEntry,
  readInventory,
  writeInventory,
  type Inventory,
  type InventoryEntry,
  type InventoryStatus
} from "./inventory.js";
import { loadIgnoreRules } from "./ignore.js";
import { hashFileSha256 } from "../repo/hash.js";
import { getGitDiff, getGitStatus } from "../repo/git.js";
import { listRepoFiles } from "../repo/file-list.js";
import { fromRepoPath, normalizeRepoPath } from "../repo/path.js";
import { searchText } from "../repo/search.js";

export type MemoryAgentToolEvent =
  | { type: "tool-call"; tool: string; input: unknown }
  | { type: "tool-result"; tool: string; result: unknown };

export interface MemoryAgentToolsOptions {
  workspaceRoot: string;
  maxReadBytes?: number;
  maxSearchResults?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: MemoryAgentToolEvent) => void;
}

export class MemoryAgentTools {
  readonly events: MemoryAgentToolEvent[] = [];

  constructor(private readonly options: MemoryAgentToolsOptions) {}

  async getCoverageStatus(): Promise<unknown> {
    return await this.record("get_coverage_status", {}, async () => {
      const inventory = await readInventory(this.options.workspaceRoot);
      const scan = await inspectCoverage(this.options.workspaceRoot, inventory);
      return {
        status: scan.status,
        issues: scan.issues,
        fileCount: Object.keys(scan.reconciledInventory.files).length
      };
    });
  }

  async listFiles(pattern?: string): Promise<unknown> {
    return await this.record("list_files", { pattern }, async () => {
      const files = await listRepoFiles(this.options.workspaceRoot, { ignoreRules: await loadIgnoreRules(this.options.workspaceRoot) });
      const normalizedPattern = pattern ? normalizeRepoPath(pattern) : undefined;
      return files
        .map((file) => file.path)
        .filter((file) => !normalizedPattern || file.includes(normalizedPattern))
        .slice(0, 500);
    });
  }

  async readFile(repoPath: string): Promise<unknown> {
    return await this.record("read_file", { path: repoPath }, async () => {
      const safePath = assertSafeRepoPath(repoPath);
      if (safePath.startsWith(".apeiron/")) {
        throw new Error("Use read_memory_file for .apeiron memory paths");
      }
      const absolutePath = fromRepoPath(this.options.workspaceRoot, safePath);
      const content = await readTextForPrompt(absolutePath, this.options.maxReadBytes ?? 20000);
      await this.touchLastReadAt(safePath);
      return { path: safePath, content };
    });
  }

  async searchText(query: string, scope?: string): Promise<unknown> {
    return await this.record("search_text", { query, scope }, async () => {
      return await searchText({
        workspaceRoot: this.options.workspaceRoot,
        query,
        scope,
        maxResults: this.options.maxSearchResults ?? 30
      });
    });
  }

  async getGitStatus(): Promise<unknown> {
    return await this.record("get_git_status", {}, async () => await getGitStatus(this.options.workspaceRoot));
  }

  async getGitDiff(repoPath?: string): Promise<unknown> {
    return await this.record("get_git_diff", { path: repoPath }, async () => {
      return await getGitDiff(this.options.workspaceRoot, repoPath ? [repoPath] : []);
    });
  }

  async findSummaryForFile(repoPath: string): Promise<unknown> {
    return await this.record("find_summary_for_file", { path: repoPath }, async () => {
      const inventory = await this.requireInventory();
      const safePath = assertSafeRepoPath(repoPath);
      const entry = inventory.files[safePath] ?? null;
      return {
        path: safePath,
        entry,
        summaryRef: entry?.summaryRef ?? null
      };
    });
  }

  async readMemoryFile(repoPath: string): Promise<unknown> {
    return await this.record("read_memory_file", { path: repoPath }, async () => {
      const safePath = assertMemoryPath(repoPath);
      const absolutePath = fromRepoPath(this.options.workspaceRoot, safePath);
      const content = existsSync(absolutePath) ? await readTextForPrompt(absolutePath, this.options.maxReadBytes ?? 20000) : "";
      return { path: safePath, content };
    });
  }

  async writeMemoryFile(repoPath: string, content: string): Promise<unknown> {
    return await this.record("write_memory_file", { path: repoPath, bytes: content.length }, async () => {
      const safePath = assertMemoryPath(repoPath);
      if (safePath === ".apeiron/memory/MEMORY.md") {
        throw new Error("Use append_memory_fact for MEMORY.md; it is append-only");
      }
      const absolutePath = fromRepoPath(this.options.workspaceRoot, safePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      return { path: safePath, written: true };
    });
  }

  async appendMemoryFact(fact: string): Promise<unknown> {
    return await this.record("append_memory_fact", { fact }, async () => {
      const normalized = normalizeFact(fact);
      if (!normalized) {
        return { appended: false, reason: "empty fact" };
      }
      const memoryPath = fromRepoPath(this.options.workspaceRoot, ".apeiron/memory/MEMORY.md");
      const current = existsSync(memoryPath) ? await fs.readFile(memoryPath, "utf8") : "# Memory\n\nLong-term maintenance facts only.\n\n";
      const existing = new Set(
        current
          .split(/\r?\n/)
          .map((line) => normalizeFact(line.replace(/^[-*]\s*/, "")))
          .filter(Boolean)
      );
      if (existing.has(normalized)) {
        return { appended: false, reason: "duplicate fact" };
      }
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.writeFile(memoryPath, `${current.endsWith("\n") ? current : `${current}\n`}- ${normalized}\n`, "utf8");
      return { appended: true, fact: normalized };
    });
  }

  async updateInventoryEntry(repoPath: string, patch: Partial<InventoryEntry>): Promise<unknown> {
    return await this.record("update_inventory_entry", { path: repoPath, patch }, async () => {
      const inventory = await this.requireInventory();
      const safePath = assertSafeRepoPath(repoPath);
      const absolutePath = fromRepoPath(this.options.workspaceRoot, safePath);
      const existing = inventory.files[safePath];
      const hash = existsSync(absolutePath) ? await hashFileSha256(absolutePath) : null;
      inventory.files[safePath] = {
        ...(existing ??
          createDiscoveredEntry({
            kind: classifyPath(safePath),
            status: "unread",
            purpose: `File discovered during memory agent run: ${safePath}`,
            reason: "new-file-detected",
            hash
          })),
        ...patch,
        kind: patch.kind ?? existing?.kind ?? classifyPath(safePath),
        status: (patch.status ?? existing?.status ?? "unread") as InventoryStatus,
        hash: patch.hash ?? hash,
        lastRefreshAt: patch.lastRefreshAt ?? new Date().toISOString()
      };
      await writeInventory(this.options.workspaceRoot, inventory);
      return { path: safePath, entry: inventory.files[safePath] };
    });
  }

  async markFileIgnored(repoPath: string, reason: string): Promise<unknown> {
    return await this.record("mark_file_ignored", { path: repoPath, reason }, async () => {
      if (!reason.trim()) {
        throw new Error("mark_file_ignored requires a reason");
      }
      return await this.updateInventoryEntry(repoPath, {
        status: "ignored",
        reason,
        summaryRef: null,
        purpose: `Ignored: ${reason}`
      });
    });
  }

  async markFilesIgnored(repoPaths: string[], reason: string): Promise<unknown> {
    return await this.record("mark_files_ignored", { paths: repoPaths, reason }, async () => {
      const normalizedReason = reason.trim();
      if (!normalizedReason) {
        throw new Error("mark_files_ignored requires a reason");
      }
      if (!Array.isArray(repoPaths) || repoPaths.length === 0) {
        throw new Error("mark_files_ignored requires at least one path");
      }
      const inventory = await this.requireInventory();
      const marked: Array<{ path: string; entry: InventoryEntry }> = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const repoPath of repoPaths) {
        try {
          const safePath = assertSafeRepoPath(repoPath);
          const absolutePath = fromRepoPath(this.options.workspaceRoot, safePath);
          const existing = inventory.files[safePath];
          const hash = existsSync(absolutePath) ? await hashFileSha256(absolutePath) : null;
          const entry = {
            ...(existing ??
              createDiscoveredEntry({
                kind: classifyPath(safePath),
                status: "unread",
                purpose: `File discovered during memory agent run: ${safePath}`,
                reason: "new-file-detected",
                hash
              })),
            status: "ignored" as InventoryStatus,
            reason: normalizedReason,
            summaryRef: null,
            purpose: `Ignored: ${normalizedReason}`,
            hash,
            lastRefreshAt: new Date().toISOString()
          };
          inventory.files[safePath] = entry;
          marked.push({ path: safePath, entry });
        } catch (error) {
          failed.push({ path: String(repoPath), error: error instanceof Error ? error.message : String(error) });
        }
      }
      await writeInventory(this.options.workspaceRoot, inventory);
      return { marked, failed };
    });
  }

  async ignoreExtensions(extensions: string[], reason: string): Promise<unknown> {
    return await this.record("ignore_extensions", { extensions, reason }, async () => {
      const normalizedReason = reason.trim();
      if (!normalizedReason) {
        throw new Error("ignore_extensions requires a reason");
      }
      if (!Array.isArray(extensions) || extensions.length === 0) {
        throw new Error("ignore_extensions requires at least one extension");
      }
      const normalizedExtensions = Array.from(new Set(extensions.map(normalizeExtensionPattern).filter(Boolean))).sort();
      if (normalizedExtensions.length === 0) {
        throw new Error("ignore_extensions requires valid extensions");
      }
      const ignorePath = path.join(this.options.workspaceRoot, ".apeiron", "ignore.md");
      const current = existsSync(ignorePath) ? await fs.readFile(ignorePath, "utf8") : "# Apeiron ignore rules\n\n# One pattern per line. These rules affect warmup and coverage scan.\n";
      const existing = new Set(
        current
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
      );
      const added = normalizedExtensions.filter((pattern) => !existing.has(pattern));
      if (added.length > 0) {
        const block = [
          "",
          `# ${normalizedReason}`,
          ...added
        ].join("\n");
        await fs.mkdir(path.dirname(ignorePath), { recursive: true });
        await fs.writeFile(ignorePath, `${current.endsWith("\n") ? current.trimEnd() : current}${block}\n`, "utf8");
      }
      return {
        added,
        skipped: normalizedExtensions.filter((pattern) => existing.has(pattern)),
        path: ".apeiron/ignore.md"
      };
    });
  }

  private async requireInventory(): Promise<Inventory> {
    const inventory = await readInventory(this.options.workspaceRoot);
    if (!inventory) {
      throw new Error("Missing .apeiron/memory/inventory.json");
    }
    return inventory;
  }

  private async touchLastReadAt(repoPath: string): Promise<void> {
    const inventory = await readInventory(this.options.workspaceRoot);
    if (!inventory?.files[repoPath]) {
      return;
    }
    inventory.files[repoPath] = {
      ...inventory.files[repoPath],
      lastReadAt: new Date().toISOString()
    };
    await writeInventory(this.options.workspaceRoot, inventory);
  }

  private async record<T>(tool: string, input: unknown, fn: () => Promise<T>): Promise<T> {
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool, input });
    try {
      const result = await fn();
      this.emit({ type: "tool-result", tool, result });
      return result;
    } catch (error) {
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      this.emit({ type: "tool-result", tool, result });
      return result as T;
    }
  }

  private emit(event: MemoryAgentToolEvent): void {
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  private throwIfAborted(): void {
    if (this.options.abortSignal?.aborted) {
      throw new Error("Apeiron run aborted");
    }
  }
}

function assertSafeRepoPath(repoPath: string): string {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized || normalized === "." || path.isAbsolute(repoPath) || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("path must be a safe repo-relative path");
  }
  return normalized;
}

function assertMemoryPath(repoPath: string): string {
  const normalized = assertSafeRepoPath(repoPath);
  if (!normalized.startsWith(".apeiron/memory/")) {
    throw new Error("memory writes are limited to .apeiron/memory/");
  }
  if (normalized.endsWith("inventory.json")) {
    throw new Error("Use update_inventory_entry for inventory changes");
  }
  return normalized;
}

async function readTextForPrompt(absolutePath: string, maxBytes: number): Promise<string> {
  const content = await fs.readFile(absolutePath, "utf8");
  return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n[truncated]` : content;
}

function normalizeFact(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ");
}

function normalizeExtensionPattern(value: string): string {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  const extension = trimmed.startsWith("*.") ? trimmed.slice(1) : trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  if (!/^\.[a-z0-9][a-z0-9+-]*$/i.test(extension)) {
    return "";
  }
  return `*${extension}`;
}
