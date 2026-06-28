import { normalizeRepoPath } from "../repo/path.js";

export type RefreshTargetKind = "read" | "modified" | "created" | "deleted";
export type RefreshTargetPriority = "must-refresh" | "opportunistic" | "ignore-unless-memory-wrong";

export interface RefreshTarget {
  path: string;
  kinds: RefreshTargetKind[];
  priority: RefreshTargetPriority;
  reason: string;
}

export class RefreshTargetTracker {
  private readonly targets = new Map<string, Set<RefreshTargetKind>>();

  markRead(path: string): void {
    this.mark(path, "read");
  }

  markModified(path: string): void {
    this.mark(path, "modified");
  }

  markCreated(path: string): void {
    this.mark(path, "created");
  }

  markDeleted(path: string): void {
    this.mark(path, "deleted");
  }

  list(): RefreshTarget[] {
    return Array.from(this.targets.entries())
      .map(([targetPath, kinds]) => buildTarget(targetPath, Array.from(kinds)))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private mark(path: string, kind: RefreshTargetKind): void {
    const normalized = normalizeRepoPath(path);
    const existing = this.targets.get(normalized) ?? new Set<RefreshTargetKind>();
    existing.add(kind);
    this.targets.set(normalized, existing);
  }
}

function buildTarget(path: string, kinds: RefreshTargetKind[]): RefreshTarget {
  if (kinds.some((kind) => kind === "modified" || kind === "created" || kind === "deleted")) {
    return {
      path,
      kinds,
      priority: "must-refresh",
      reason: "file content or presence changed during work"
    };
  }
  return {
    path,
    kinds,
    priority: "opportunistic",
    reason: "file was read during work and may support opportunistic warmup if inventory status is unread"
  };
}
