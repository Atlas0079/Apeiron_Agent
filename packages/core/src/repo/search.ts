import fs from "node:fs/promises";
import path from "node:path";
import { loadIgnoreRules } from "../memory/ignore.js";
import { listRepoFiles } from "./file-list.js";
import { normalizeRepoPath, toRepoPath } from "./path.js";

export interface SearchTextInput {
  workspaceRoot: string;
  query: string;
  scope?: string;
  maxResults?: number;
}

export interface SearchTextResult {
  path: string;
  line: number;
  preview: string;
}

export async function searchText(input: SearchTextInput): Promise<SearchTextResult[]> {
  const query = input.query;
  if (!query) {
    return [];
  }
  const rules = await loadIgnoreRules(input.workspaceRoot);
  const files = await listRepoFiles(input.workspaceRoot, { ignoreRules: rules });
  const maxResults = input.maxResults ?? 20;
  const scope = normalizeSearchScope(input.workspaceRoot, input.scope);
  const results: SearchTextResult[] = [];
  for (const file of files) {
    if (scope && !(file.path === scope || file.path.startsWith(`${scope}/`))) {
      continue;
    }
    if (isLikelyBinary(file.path)) {
      continue;
    }
    const content = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) {
        continue;
      }
      results.push({
        path: file.path,
        line: index + 1,
        preview: lines[index].trim().slice(0, 300)
      });
      if (results.length >= maxResults) {
        return results;
      }
    }
  }
  return results;
}

function isLikelyBinary(repoPath: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|wasm|exe|dll|bin|ttf|woff2?)$/i.test(repoPath);
}

function normalizeSearchScope(workspaceRoot: string, scope: string | undefined): string | undefined {
  if (!scope) {
    return undefined;
  }
  const normalized = normalizeRepoPath(scope);
  if (!path.isAbsolute(scope)) {
    return normalized;
  }
  const relative = toRepoPath(workspaceRoot, scope);
  if (relative.startsWith("..")) {
    return undefined;
  }
  return relative;
}
