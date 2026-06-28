import { getGitDiff } from "../repo/git.js";

export interface MemoryDiffSummaryItem {
  path: string;
  addedLines: number;
  removedLines: number;
}

export interface MemoryDiffSummary {
  paths: string[];
  files: MemoryDiffSummaryItem[];
  diff: string;
}

export async function getMemoryDiff(workspaceRoot: string, paths: string[] = [".apeiron/memory"]): Promise<string> {
  return await getGitDiff(workspaceRoot, paths);
}

export async function summarizeMemoryDiff(workspaceRoot: string, paths: string[] = [".apeiron/memory"]): Promise<MemoryDiffSummary> {
  const diff = await getMemoryDiff(workspaceRoot, paths);
  return {
    paths,
    files: summarizeDiffByFile(diff),
    diff
  };
}

function summarizeDiffByFile(diff: string): MemoryDiffSummaryItem[] {
  const files = new Map<string, MemoryDiffSummaryItem>();
  let current: MemoryDiffSummaryItem | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const filePath = parseDiffPath(line);
      current = filePath ? { path: filePath, addedLines: 0, removedLines: 0 } : undefined;
      if (current) {
        files.set(current.path, current);
      }
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      current.addedLines += 1;
    } else if (line.startsWith("-")) {
      current.removedLines += 1;
    }
  }
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function parseDiffPath(line: string): string | null {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match?.[2] ?? match?.[1] ?? null;
}
