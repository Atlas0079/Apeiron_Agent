import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RefreshTarget } from "../memory/refresh-targets.js";
import { decideIgnored, loadIgnoreRules } from "../memory/ignore.js";
import { isApeironDefaultFocusedFile } from "./focus.js";
import { normalizeRepoPath } from "./path.js";

const execFileAsync = promisify(execFile);

export type GitChangeKind = "modified" | "created" | "deleted" | "renamed" | "untracked" | "unknown";

export interface GitChange {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: GitChangeKind;
}

export interface GitStatus {
  branch?: string;
  gitRoot?: string;
  changes: GitChange[];
}

export async function getGitStatus(workspaceRoot: string): Promise<GitStatus> {
  const gitRoot = await git(["rev-parse", "--show-toplevel"], workspaceRoot).then((value) => path.resolve(value.trim())).catch(() => undefined);
  const branch = await git(["branch", "--show-current"], workspaceRoot).then((value) => value.trim()).catch(() => undefined);
  const porcelain = await git(["status", "--porcelain=v1"], workspaceRoot);
  return {
    branch,
    gitRoot,
    changes: porcelain
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parsePorcelainLine)
  };
}

export async function getGitDiff(workspaceRoot: string, paths: string[] = []): Promise<string> {
  const args = ["diff", "--", ...paths.map(normalizeRepoPath)];
  return await git(args, workspaceRoot);
}

export async function createRefreshTargetsFromGitStatus(status: GitStatus, workspaceRoot?: string): Promise<RefreshTarget[]> {
  const targets = new Map<string, RefreshTarget>();
  const ignoreRules = workspaceRoot ? await loadIgnoreRules(workspaceRoot) : [];
  for (const change of status.changes) {
    const workspacePath = toWorkspaceRepoPath(change.path, status.gitRoot, workspaceRoot);
    const oldWorkspacePath = change.oldPath ? toWorkspaceRepoPath(change.oldPath, status.gitRoot, workspaceRoot) : undefined;
    if (!workspacePath || isIgnoredRefreshPath(workspacePath, ignoreRules)) {
      continue;
    }
    if (change.kind === "deleted") {
      targets.set(workspacePath, {
        path: workspacePath,
        kinds: ["deleted"],
        priority: "must-refresh",
        reason: "git status reports deleted file"
      });
      continue;
    }
    if (change.kind === "created" || change.kind === "untracked") {
      const paths = workspaceRoot ? await expandMaybeDirectory(workspaceRoot, workspacePath) : [workspacePath];
      for (const targetPath of paths) {
        if (isIgnoredRefreshPath(targetPath, ignoreRules)) {
          continue;
        }
        targets.set(targetPath, {
          path: targetPath,
          kinds: ["created"],
          priority: "must-refresh",
          reason: "git status reports new file"
        });
      }
      continue;
    }
    if (change.kind === "renamed") {
      if (oldWorkspacePath) {
        if (!isIgnoredRefreshPath(oldWorkspacePath, ignoreRules)) {
          targets.set(oldWorkspacePath, {
            path: oldWorkspacePath,
            kinds: ["deleted"],
            priority: "must-refresh",
            reason: "git status reports renamed source path"
          });
        }
      }
      targets.set(workspacePath, {
        path: workspacePath,
        kinds: ["created"],
        priority: "must-refresh",
        reason: "git status reports renamed destination path"
      });
      continue;
    }
    if (change.kind === "modified" || change.kind === "unknown") {
      targets.set(workspacePath, {
        path: workspacePath,
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "git status reports modified file"
      });
    }
  }
  return Array.from(targets.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function toWorkspaceRepoPath(repoRootPath: string, gitRoot: string | undefined, workspaceRoot: string | undefined): string | undefined {
  const normalized = normalizeRepoPath(repoRootPath);
  if (!gitRoot || !workspaceRoot) {
    return normalized;
  }
  const absolutePath = path.resolve(gitRoot, ...normalized.split("/"));
  const relativeToWorkspace = path.relative(workspaceRoot, absolutePath);
  if (relativeToWorkspace === "") {
    return undefined;
  }
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    return undefined;
  }
  return normalizeRepoPath(relativeToWorkspace);
}

export function createRefreshTargetsFromGitStatusSync(status: GitStatus): RefreshTarget[] {
  const targets = new Map<string, RefreshTarget>();
  for (const change of status.changes) {
    if (change.path.startsWith(".apeiron/")) {
      continue;
    }
    const kind = change.kind === "deleted" ? "deleted" : change.kind === "created" || change.kind === "untracked" ? "created" : "modified";
    targets.set(change.path, {
      path: change.path,
      kinds: [kind],
      priority: "must-refresh",
      reason: `git status reports ${kind} file`
    });
  }
  return Array.from(targets.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function isIgnoredRefreshPath(repoPath: string, rules: Awaited<ReturnType<typeof loadIgnoreRules>>): boolean {
  const normalized = normalizeRepoPath(repoPath);
  return normalized.startsWith(".apeiron/") || !isApeironDefaultFocusedFile(normalized) || decideIgnored(normalized, rules).ignored;
}

function parsePorcelainLine(line: string): GitChange {
  const indexStatus = line[0] ?? " ";
  const worktreeStatus = line[1] ?? " ";
  const rawPath = line.slice(3);
  if (indexStatus === "R" || worktreeStatus === "R") {
    const [oldPath, newPath] = rawPath.split(" -> ");
    return {
      path: normalizeRepoPath(newPath ?? rawPath),
      oldPath: oldPath ? normalizeRepoPath(oldPath) : undefined,
      indexStatus,
      worktreeStatus,
      kind: "renamed"
    };
  }
  return {
    path: normalizeRepoPath(rawPath),
    indexStatus,
    worktreeStatus,
    kind: classifyStatus(indexStatus, worktreeStatus)
  };
}

function classifyStatus(indexStatus: string, worktreeStatus: string): GitChangeKind {
  if (indexStatus === "?" && worktreeStatus === "?") {
    return "untracked";
  }
  if (indexStatus === "A" || worktreeStatus === "A") {
    return "created";
  }
  if (indexStatus === "D" || worktreeStatus === "D") {
    return "deleted";
  }
  if (indexStatus === "M" || worktreeStatus === "M") {
    return "modified";
  }
  return "unknown";
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

async function expandMaybeDirectory(workspaceRoot: string, repoPath: string): Promise<string[]> {
  const absolutePath = path.join(workspaceRoot, ...normalizeRepoPath(repoPath).split("/"));
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isDirectory()) {
    return [normalizeRepoPath(repoPath)];
  }
  const gitListed = await git(["ls-files", "--others", "--exclude-standard", "--", normalizeRepoPath(repoPath)], workspaceRoot).catch(
    () => null
  );
  if (gitListed !== null) {
    return gitListed
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizeRepoPath)
      .filter((file) => !file.startsWith(".apeiron/"))
      .sort();
  }
  const files: string[] = [];
  await walkDirectory(workspaceRoot, absolutePath, files);
  return files.filter((file) => !file.startsWith(".apeiron/") && isApeironDefaultFocusedFile(file)).sort();
}

async function walkDirectory(workspaceRoot: string, absoluteDir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(workspaceRoot, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(normalizeRepoPath(path.relative(workspaceRoot, absolutePath)));
  }
}
