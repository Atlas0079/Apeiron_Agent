import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRepoPath } from "../repo/path.js";

export type IgnoreRuleSource = ".gitignore" | ".apeiron/ignore.md" | "default";

export interface IgnoreRule {
  pattern: string;
  source: IgnoreRuleSource;
  line?: number;
}

export interface IgnoreDecision {
  ignored: boolean;
  reason?: string;
  rule?: IgnoreRule;
}

// These rules define Apeiron coverage/work-tool exclusions, not git tracking.
// .apeiron/memory is intentionally versioned by git but excluded from repo coverage
// so inventory describes project source files rather than Apeiron's own memory docs.
const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".DS_Store",
  ".tmp-smoke/",
  "targets.json",
  "*targets*.json",
  ".apeiron/memory/",
  ".apeiron/memory/inventory.json",
  ".apeiron/sessions/",
  ".apeiron/context-packs/",
  ".apeiron/attachments/"
];

export async function loadIgnoreRules(workspaceRoot: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = DEFAULT_IGNORE_PATTERNS.map((pattern) => ({ pattern, source: "default" }));
  rules.push(...(await readIgnoreFile(path.join(workspaceRoot, ".gitignore"), ".gitignore")));
  rules.push(...(await readIgnoreFile(path.join(workspaceRoot, ".apeiron", "ignore.md"), ".apeiron/ignore.md")));
  return rules;
}

async function readIgnoreFile(filePath: string, source: IgnoreRuleSource): Promise<IgnoreRule[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(({ text }) => text.length > 0 && !text.startsWith("#"))
    .filter(({ text }) => !text.startsWith("!"))
    .map(({ text, line }) => ({ pattern: normalizeRepoPath(text), source, line }));
}

export function decideIgnored(repoPath: string, rules: IgnoreRule[]): IgnoreDecision {
  const normalized = normalizeRepoPath(repoPath);
  for (const rule of rules) {
    if (matchesRule(normalized, rule.pattern)) {
      return {
        ignored: true,
        reason: `matched ${rule.source}:${rule.line ?? "default"} ${rule.pattern}`,
        rule
      };
    }
  }
  return { ignored: false };
}

export function matchesRule(repoPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRepoPath(pattern);
  if (normalizedPattern.endsWith("/")) {
    const prefix = normalizedPattern.slice(0, -1);
    return repoPath === prefix || repoPath.startsWith(`${prefix}/`) || repoPath.split("/").includes(prefix);
  }
  if (!normalizedPattern.includes("/") && !hasGlob(normalizedPattern)) {
    return repoPath === normalizedPattern || repoPath.split("/").includes(normalizedPattern);
  }
  if (!hasGlob(normalizedPattern)) {
    return repoPath === normalizedPattern || repoPath.startsWith(`${normalizedPattern}/`);
  }
  return globToRegex(normalizedPattern).test(repoPath);
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}
