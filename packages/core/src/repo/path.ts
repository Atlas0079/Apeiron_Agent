import path from "node:path";

export function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function toRepoPath(workspaceRoot: string, absolutePath: string): string {
  return normalizeRepoPath(path.relative(workspaceRoot, absolutePath));
}

export function fromRepoPath(workspaceRoot: string, repoPath: string): string {
  return path.join(workspaceRoot, ...normalizeRepoPath(repoPath).split("/"));
}
