import { createRefreshTargetsFromGitStatus, type GitChange, type GitStatus } from "../repo/git.js";
import { normalizeRepoPath } from "../repo/path.js";
import type { RefreshTarget } from "../memory/refresh-targets.js";

export interface TurnChangeBoundaryInput {
  beforeStatus?: GitStatus;
  afterStatus?: GitStatus;
  trackedTargets: RefreshTarget[];
  workspaceRoot?: string;
}

export interface TurnChangeBoundaryResult {
  refreshTargets: RefreshTarget[];
  touchedTargets: RefreshTarget[];
  gitDeltaTargets: RefreshTarget[];
  ignoredPreexistingDirty: GitChange[];
}

export async function createTurnChangeBoundary(input: TurnChangeBoundaryInput): Promise<TurnChangeBoundaryResult> {
  const touchedTargets = normalizeTargets(input.trackedTargets);
  const touchedPaths = new Set(touchedTargets.map((target) => target.path));
  const beforeChanges = normalizeChanges(input.beforeStatus?.changes ?? []);
  const afterChanges = normalizeChanges(input.afterStatus?.changes ?? []);
  const turnGitChanges: GitChange[] = [];
  const ignoredPreexistingDirty: GitChange[] = [];

  for (const change of afterChanges.values()) {
    const before = beforeChanges.get(change.path);
    if (!before) {
      turnGitChanges.push(change);
      continue;
    }
    if (gitChangeSignature(before) !== gitChangeSignature(change)) {
      turnGitChanges.push(change);
      continue;
    }
    if (touchedPaths.has(change.path)) {
      continue;
    }
    ignoredPreexistingDirty.push(change);
  }

  const gitDeltaTargets = await createRefreshTargetsFromGitStatus(
    {
      branch: input.afterStatus?.branch,
      gitRoot: input.afterStatus?.gitRoot,
      changes: turnGitChanges
    },
    input.workspaceRoot
  );

  return {
    refreshTargets: mergeTargets(touchedTargets, gitDeltaTargets),
    touchedTargets,
    gitDeltaTargets,
    ignoredPreexistingDirty: ignoredPreexistingDirty.sort((a, b) => a.path.localeCompare(b.path))
  };
}

function normalizeTargets(targets: RefreshTarget[]): RefreshTarget[] {
  return targets.map((target) => ({ ...target, path: normalizeRepoPath(target.path) })).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeChanges(changes: GitChange[]): Map<string, GitChange> {
  const normalized = new Map<string, GitChange>();
  for (const change of changes) {
    const repoPath = normalizeRepoPath(change.path);
    normalized.set(repoPath, {
      ...change,
      path: repoPath,
      oldPath: change.oldPath ? normalizeRepoPath(change.oldPath) : undefined
    });
  }
  return normalized;
}

function gitChangeSignature(change: GitChange): string {
  return JSON.stringify({
    path: normalizeRepoPath(change.path),
    oldPath: change.oldPath ? normalizeRepoPath(change.oldPath) : null,
    indexStatus: change.indexStatus,
    worktreeStatus: change.worktreeStatus,
    kind: change.kind
  });
}

function mergeTargets(...targetGroups: RefreshTarget[][]): RefreshTarget[] {
  const merged = new Map<string, RefreshTarget>();
  for (const group of targetGroups) {
    for (const target of group) {
      const repoPath = normalizeRepoPath(target.path);
      const existing = merged.get(repoPath);
      if (!existing) {
        merged.set(repoPath, {
          ...target,
          path: repoPath,
          kinds: normalizeKinds(target.kinds)
        });
        continue;
      }
      const kinds = normalizeKinds([...existing.kinds, ...target.kinds]);
      merged.set(repoPath, {
        path: repoPath,
        kinds,
        priority: existing.priority === "must-refresh" || target.priority === "must-refresh" ? "must-refresh" : existing.priority,
        reason: existing.reason === target.reason ? existing.reason : `${existing.reason}; ${target.reason}`
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeKinds(kinds: RefreshTarget["kinds"]): RefreshTarget["kinds"] {
  return Array.from(new Set(kinds)).sort() as RefreshTarget["kinds"];
}
