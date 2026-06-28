import fs from "node:fs/promises";
import path from "node:path";
import { decideIgnored, type IgnoreRule } from "../memory/ignore.js";
import { normalizeRepoPath } from "./path.js";

export interface RepoFile {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface ListRepoFilesOptions {
  ignoreRules?: IgnoreRule[];
}

export async function listRepoFiles(workspaceRoot: string, options: ListRepoFilesOptions = {}): Promise<RepoFile[]> {
  const root = path.resolve(workspaceRoot);
  const files: RepoFile[] = [];
  await walk(root, "", files, options.ignoreRules ?? []);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root: string, repoDir: string, files: RepoFile[], ignoreRules: IgnoreRule[]): Promise<void> {
  const absoluteDir = path.join(root, ...repoDir.split("/").filter(Boolean));
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const repoPath = normalizeRepoPath(repoDir ? `${repoDir}/${entry.name}` : entry.name);
    if (decideIgnored(entry.isDirectory() ? `${repoPath}/` : repoPath, ignoreRules).ignored) {
      continue;
    }
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, repoPath, files, ignoreRules);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    files.push({
      path: repoPath,
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
}
