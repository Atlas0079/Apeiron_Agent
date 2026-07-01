import path from "node:path";
import { normalizeRepoPath } from "./path.js";

const FOCUSED_EXTENSIONS = new Set([
  ".astro",
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cxx",
  ".fish",
  ".go",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".md",
  ".mdx",
  ".mjs",
  ".mm",
  ".mts",
  ".php",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);

const FOCUSED_BASENAMES = new Set([
  ".babelrc",
  ".editorconfig",
  ".env",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "Cargo.lock",
  "Dockerfile",
  "Gemfile",
  "Gemfile.lock",
  "LICENSE",
  "Makefile",
  "NOTICE",
  "Procfile",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

const FOCUSED_SUFFIXES = [".config.js", ".config.mjs", ".config.cjs", ".config.ts", ".env.example", ".env.local"];

export function isApeironDefaultFocusedFile(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  const baseName = path.posix.basename(normalized);
  if (FOCUSED_BASENAMES.has(baseName)) {
    return true;
  }
  if (baseName.startsWith(".env.")) {
    return true;
  }
  if (FOCUSED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }
  return FOCUSED_EXTENSIONS.has(path.posix.extname(normalized));
}
