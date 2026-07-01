export type ApeironLlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ApeironLlmMessage {
  role: "system" | "user" | "assistant";
  content: string | ApeironLlmContentPart[];
}

export interface ApeironLlmOptions {
  provider?: string;
  api?: "openai-completions";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  retryAttempts?: number;
  retryDelayMs?: number;
  retryBackoff?: number;
}

export interface ApeironLlmClient {
  complete(messages: ApeironLlmMessage[], options?: ApeironLlmOptions): Promise<string>;
}

export interface ApeironLlmRetryEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  category: string;
  message: string;
}

export function readApeironLlmEnv(): ApeironLlmOptions {
  return {
    provider: process.env.APEIRON_PROVIDER,
    api: process.env.APEIRON_MODEL_API === "openai-completions" || !process.env.APEIRON_MODEL_API
      ? "openai-completions"
      : undefined,
    baseUrl: process.env.APEIRON_OPENAI_BASE_URL,
    apiKey: process.env.APEIRON_OPENAI_API_KEY,
    model: process.env.APEIRON_MODEL,
    reasoning: parseReasoning(process.env.APEIRON_REASONING),
    retryAttempts: parsePositiveInteger(process.env.APEIRON_LLM_RETRY_ATTEMPTS),
    retryDelayMs: parsePositiveInteger(process.env.APEIRON_LLM_RETRY_DELAY_MS),
    retryBackoff: parsePositiveNumber(process.env.APEIRON_LLM_RETRY_BACKOFF)
  };
}

export async function completeWithRetry(
  client: ApeironLlmClient,
  messages: ApeironLlmMessage[],
  options: ApeironLlmOptions = {},
  onRetry?: (event: ApeironLlmRetryEvent) => void
): Promise<string> {
  const maxAttempts = clampInteger(options.retryAttempts ?? 3, 1, 10);
  const baseDelayMs = clampInteger(options.retryDelayMs ?? 1000, 0, 60000);
  const backoff = clampNumber(options.retryBackoff ?? 2, 1, 10);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.complete(messages, options);
    } catch (error) {
      const classified = classifyLlmError(error);
      if (!classified.retryable || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = Math.round(baseDelayMs * (backoff ** (attempt - 1)));
      onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        category: classified.category,
        message: classified.message
      });
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error("LLM retry loop ended unexpectedly");
}

export async function completeJsonWithRetry<T>(
  client: ApeironLlmClient,
  messages: ApeironLlmMessage[],
  options: ApeironLlmOptions = {},
  onRetry?: (event: ApeironLlmRetryEvent) => void
): Promise<{ raw: string; parsed: T }> {
  const raw = await completeWithRetry(
    {
      async complete(nextMessages, nextOptions) {
        const text = await client.complete(nextMessages, nextOptions);
        try {
          return JSON.stringify({
            raw: text,
            parsed: extractJsonObject<T>(text)
          });
        } catch (error) {
          if (isRetryableNonJsonResponse(text, error)) {
            throw new Error(`LLM request failed: retryable non-JSON response: ${summarizeTextForError(text)}`);
          }
          throw error;
        }
      }
    },
    messages,
    options,
    onRetry
  );
  return JSON.parse(raw) as { raw: string; parsed: T };
}

export function extractJsonObject<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("LLM response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1).replace(/^\uFEFF/, "")) as T;
}

function isRetryableNonJsonResponse(text: string, error: unknown): boolean {
  const lower = text.toLowerCase();
  if (looksLikeHtmlErrorPage(lower)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("unexpected token") && (lower.includes("524") || lower.includes("timeout") || lower.includes("server"));
}

function looksLikeHtmlErrorPage(lowerText: string): boolean {
  return (
    lowerText.includes("<html") &&
    (
      lowerText.includes("524") ||
      lowerText.includes("cloudflare") ||
      lowerText.includes("无法连接到服务器") ||
      lowerText.includes("cannot connect to server") ||
      lowerText.includes("server error") ||
      lowerText.includes("timeout")
    )
  );
}

function summarizeTextForError(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function parseReasoning(value: string | undefined): ApeironLlmOptions["reasoning"] {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function classifyLlmError(error: unknown): { category: string; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("missing apeiron_openai") || lower.includes("missing apeiron_model") || lower.includes("unsupported apeiron_model_api")) {
    return { category: "config", message, retryable: false };
  }
  if (lower.includes("llm response did not contain a json object")) {
    return { category: "format", message, retryable: false };
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("api key")) {
    return { category: "auth", message, retryable: false };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many request")) {
    return { category: "rate-limit", message, retryable: true };
  }
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("fetch failed") || lower.includes("econn") || lower.includes("enotfound")) {
    return { category: "network", message, retryable: true };
  }
  if (lower.includes("llm request failed") || lower.includes("stopreason=error") || /\b5\d\d\b/.test(lower)) {
    return { category: "provider", message, retryable: true };
  }
  return { category: "unknown", message, retryable: true };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
