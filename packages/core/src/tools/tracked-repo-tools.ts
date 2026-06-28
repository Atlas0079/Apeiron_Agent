import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { decideIgnored, loadIgnoreRules, type IgnoreRule } from "../memory/ignore.js";
import { RefreshTargetTracker, type RefreshTarget } from "../memory/refresh-targets.js";
import { fromRepoPath, normalizeRepoPath } from "../repo/path.js";
import { searchText, type SearchTextResult } from "../repo/search.js";

const execFileAsync = promisify(execFile);

export type TrackedToolEvent =
  | { type: "tool-call"; tool: "read_file"; path: string }
  | { type: "tool-call"; tool: "search_text"; query: string; scope?: string }
  | { type: "tool-call"; tool: "write_file"; path: string; bytes: number }
  | { type: "tool-call"; tool: "delete_file"; path: string }
  | { type: "tool-call"; tool: "run_command"; command: string }
  | { type: "tool-result"; tool: "read_file"; path: string; ok: boolean; bytes?: number; error?: string }
  | { type: "tool-result"; tool: "search_text"; query: string; resultCount: number }
  | { type: "tool-result"; tool: "write_file"; path: string; ok: boolean; created?: boolean; error?: string }
  | { type: "tool-result"; tool: "delete_file"; path: string; ok: boolean; error?: string }
  | { type: "tool-result"; tool: "run_command"; command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TrackedRepoToolsOptions {
  workspaceRoot: string;
  maxReadBytes?: number;
  maxSearchResults?: number;
  commandTimeoutMs?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: TrackedToolEvent) => void;
}

export class TrackedRepoTools {
  readonly events: TrackedToolEvent[] = [];
  private readonly tracker = new RefreshTargetTracker();
  private ignoreRules: IgnoreRule[] | undefined;

  constructor(private readonly options: TrackedRepoToolsOptions) {}

  listRefreshTargets(): RefreshTarget[] {
    return this.tracker.list();
  }

  async readFile(repoPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const normalized = await this.validateReadablePath(repoPath);
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool: "read_file", path: normalized.path });
    if (!normalized.ok) {
      const result = { ok: false, error: normalized.error };
      this.emit({ type: "tool-result", tool: "read_file", path: normalized.path, ok: false, error: normalized.error });
      return result;
    }
    const absolutePath = fromRepoPath(this.options.workspaceRoot, normalized.path);
    if (!existsSync(absolutePath)) {
      const result = { ok: false, error: "file does not exist" };
      this.emit({ type: "tool-result", tool: "read_file", path: normalized.path, ok: false, error: result.error });
      return result;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    this.tracker.markRead(normalized.path);
    const maxReadBytes = this.options.maxReadBytes ?? 20000;
    const truncated = content.length > maxReadBytes ? `${content.slice(0, maxReadBytes)}\n[truncated]` : content;
    this.emit({ type: "tool-result", tool: "read_file", path: normalized.path, ok: true, bytes: content.length });
    return { ok: true, content: truncated };
  }

  async searchText(query: string, scope?: string): Promise<SearchTextResult[]> {
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool: "search_text", query, scope });
    const results = await searchText({
      workspaceRoot: this.options.workspaceRoot,
      query,
      scope,
      maxResults: this.options.maxSearchResults ?? 20
    });
    this.emit({ type: "tool-result", tool: "search_text", query, resultCount: results.length });
    return results;
  }

  async writeFile(repoPath: string, content: string): Promise<{ ok: boolean; created?: boolean; error?: string }> {
    const normalized = await this.validateWritablePath(repoPath);
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool: "write_file", path: normalized.path, bytes: content.length });
    if (!normalized.ok) {
      const result = { ok: false, error: normalized.error };
      this.emit({ type: "tool-result", tool: "write_file", path: normalized.path, ok: false, error: normalized.error });
      return result;
    }
    const absolutePath = fromRepoPath(this.options.workspaceRoot, normalized.path);
    const created = !existsSync(absolutePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    if (created) {
      this.tracker.markCreated(normalized.path);
    } else {
      this.tracker.markModified(normalized.path);
    }
    this.emit({ type: "tool-result", tool: "write_file", path: normalized.path, ok: true, created });
    return { ok: true, created };
  }

  async deleteFile(repoPath: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = await this.validateWritablePath(repoPath);
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool: "delete_file", path: normalized.path });
    if (!normalized.ok) {
      const result = { ok: false, error: normalized.error };
      this.emit({ type: "tool-result", tool: "delete_file", path: normalized.path, ok: false, error: normalized.error });
      return result;
    }
    const absolutePath = fromRepoPath(this.options.workspaceRoot, normalized.path);
    if (!existsSync(absolutePath)) {
      const result = { ok: false, error: "file does not exist" };
      this.emit({ type: "tool-result", tool: "delete_file", path: normalized.path, ok: false, error: result.error });
      return result;
    }
    await fs.rm(absolutePath);
    this.tracker.markDeleted(normalized.path);
    this.emit({ type: "tool-result", tool: "delete_file", path: normalized.path, ok: true });
    return { ok: true };
  }

  async runCommand(command: string): Promise<CommandResult> {
    this.throwIfAborted();
    this.emit({ type: "tool-call", tool: "run_command", command });
    const shell = process.platform === "win32" ? "powershell.exe" : "sh";
    const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
    try {
      const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
        cwd: this.options.workspaceRoot,
        timeout: this.options.commandTimeoutMs ?? 120000,
        signal: this.options.abortSignal,
        maxBuffer: 2 * 1024 * 1024
      });
      const result = { exitCode: 0, stdout: trimOutput(stdout), stderr: trimOutput(stderr), timedOut: false };
      this.emit({ type: "tool-result", tool: "run_command", command, ...result });
      return result;
    } catch (error) {
      const err = error as { code?: number | string; signal?: string; stdout?: string; stderr?: string; killed?: boolean };
      const result = {
        exitCode: typeof err.code === "number" ? err.code : null,
        stdout: trimOutput(err.stdout ?? ""),
        stderr: trimOutput(err.stderr ?? ""),
        timedOut: Boolean(err.killed || err.signal === "SIGTERM")
      };
      this.emit({ type: "tool-result", tool: "run_command", command, ...result });
      return result;
    }
  }

  private async validateReadablePath(repoPath: string): Promise<{ ok: true; path: string } | { ok: false; path: string; error: string }> {
    const safe = await this.validatePath(repoPath);
    if (!safe.ok) {
      return safe;
    }
    if (safe.path.startsWith(".apeiron/")) {
      return { ok: false, path: safe.path, error: "memory files are not readable through work tools" };
    }
    return safe;
  }

  private async validateWritablePath(repoPath: string): Promise<{ ok: true; path: string } | { ok: false; path: string; error: string }> {
    const safe = await this.validatePath(repoPath);
    if (!safe.ok) {
      return safe;
    }
    if (safe.path.startsWith(".apeiron/")) {
      return { ok: false, path: safe.path, error: "work tools cannot edit .apeiron memory files; refresh owns memory updates" };
    }
    const rules = await this.getIgnoreRules();
    if (decideIgnored(safe.path, rules).ignored) {
      return { ok: false, path: safe.path, error: "path is ignored by Apeiron ignore rules" };
    }
    return safe;
  }

  private async validatePath(repoPath: string): Promise<{ ok: true; path: string } | { ok: false; path: string; error: string }> {
    const normalized = normalizeRepoPath(repoPath);
    if (!normalized || normalized === "." || path.isAbsolute(repoPath) || normalized.startsWith("../") || normalized.includes("/../")) {
      return { ok: false, path: normalized, error: "path must be a safe repo-relative path" };
    }
    return { ok: true, path: normalized };
  }

  private async getIgnoreRules(): Promise<IgnoreRule[]> {
    this.ignoreRules = this.ignoreRules ?? (await loadIgnoreRules(this.options.workspaceRoot));
    return this.ignoreRules;
  }

  private emit(event: TrackedToolEvent): void {
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  private throwIfAborted(): void {
    if (this.options.abortSignal?.aborted) {
      throw new Error("Apeiron run aborted");
    }
  }
}

function trimOutput(output: string): string {
  return output.length > 12000 ? `${output.slice(0, 12000)}\n[truncated]` : output;
}
