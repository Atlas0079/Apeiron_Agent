export function summarizeToolCall(event: { tool: string; path?: string; command?: string; query?: string }): string {
  if (event.path) {
    return `${event.tool}: ${event.path}`;
  }
  if (event.command) {
    return `command: ${event.command}`;
  }
  if (event.query) {
    return `search: ${event.query}`;
  }
  return event.tool;
}

export function summarizeToolResult(event: {
  tool: string;
  path?: string;
  ok?: boolean;
  exitCode?: number | null;
  resultCount?: number;
}): string {
  if (event.tool === "run_command") {
    return `command result: exit ${event.exitCode ?? "unknown"}`;
  }
  if (event.tool === "search_text") {
    return `search result: ${event.resultCount ?? 0} match(es)`;
  }
  if (event.path) {
    return `${event.tool} ${event.ok ? "ok" : "failed"}: ${event.path}`;
  }
  return `${event.tool} result`;
}

export function summarizeToolEvent(event: {
  type: string;
  tool?: string;
  path?: string;
  command?: string;
  query?: string;
  ok?: boolean;
  exitCode?: number | null;
  resultCount?: number;
}): string {
  if (event.type === "tool-call" && event.tool) {
    return summarizeToolCall({ tool: event.tool, path: event.path, command: event.command, query: event.query });
  }
  if (event.type === "tool-result" && event.tool) {
    return summarizeToolResult({
      tool: event.tool,
      path: event.path,
      ok: event.ok,
      exitCode: event.exitCode,
      resultCount: event.resultCount
    });
  }
  return event.type;
}

export function isImage(fileName: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(fileName);
}

export function mimeTypeForImage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/jpeg";
}

export function normalizeUiRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function isMemoryPath(repoPath: string): boolean {
  const normalized = normalizeUiRepoPath(repoPath);
  return normalized === ".apeiron/ignore.md" || normalized.startsWith(".apeiron/memory/");
}

export function isRuntimeApeironPath(repoPath: string): boolean {
  const normalized = normalizeUiRepoPath(repoPath);
  return normalized.startsWith(".apeiron/") && !isMemoryPath(normalized);
}

export function summarizeText(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

export function trimText(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content;
}
