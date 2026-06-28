import type * as vscode from "vscode";
import type { ApeironLlmOptions } from "@apeiron/core";

export type ProviderFormat = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface ProviderSettings {
  format: ProviderFormat;
  baseUrl: string;
  model: string;
  provider: string;
  reasoning: ApeironLlmOptions["reasoning"];
  retryAttempts: number;
  retryDelayMs: number;
  retryBackoff: number;
  hasApiKey: boolean;
}

export interface ProviderSettingsInput {
  format: ProviderFormat;
  baseUrl: string;
  model: string;
  provider: string;
  apiKey?: string;
  reasoning?: ApeironLlmOptions["reasoning"];
  retryAttempts?: number;
  retryDelayMs?: number;
  retryBackoff?: number;
}

const SETTINGS_KEY = "apeiron.providerSettings";
const API_KEY_SECRET = "apeiron.providerSettings.apiKey";

export async function readProviderSettings(context: vscode.ExtensionContext): Promise<ProviderSettings> {
  const stored = context.globalState.get<Partial<ProviderSettings>>(SETTINGS_KEY) ?? {};
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  return {
    format: normalizeFormat(stored.format),
    baseUrl: String(stored.baseUrl ?? ""),
    model: String(stored.model ?? ""),
    provider: String(stored.provider ?? "apeiron-openai-compatible"),
    reasoning: normalizeReasoning(stored.reasoning),
    retryAttempts: normalizeInteger(stored.retryAttempts, 3, 1, 10),
    retryDelayMs: normalizeInteger(stored.retryDelayMs, 1000, 0, 60000),
    retryBackoff: normalizeNumber(stored.retryBackoff, 2, 1, 10),
    hasApiKey: Boolean(apiKey)
  };
}

export async function writeProviderSettings(context: vscode.ExtensionContext, input: ProviderSettingsInput): Promise<ProviderSettings> {
  const next = {
    format: normalizeFormat(input.format),
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
    provider: input.provider.trim() || defaultProviderForFormat(input.format),
    reasoning: normalizeReasoning(input.reasoning),
    retryAttempts: normalizeInteger(input.retryAttempts, 3, 1, 10),
    retryDelayMs: normalizeInteger(input.retryDelayMs, 1000, 0, 60000),
    retryBackoff: normalizeNumber(input.retryBackoff, 2, 1, 10)
  };
  await context.globalState.update(SETTINGS_KEY, next);
  if (input.apiKey !== undefined) {
    const apiKey = input.apiKey.trim();
    if (apiKey) {
      await context.secrets.store(API_KEY_SECRET, apiKey);
    }
  }
  return await readProviderSettings(context);
}

export async function clearProviderApiKey(context: vscode.ExtensionContext): Promise<ProviderSettings> {
  await context.secrets.delete(API_KEY_SECRET);
  return await readProviderSettings(context);
}

export async function resolveProviderLlmOptions(context: vscode.ExtensionContext): Promise<Partial<ApeironLlmOptions>> {
  const settings = await readProviderSettings(context);
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!settings.baseUrl && !settings.model && !apiKey) {
    return {};
  }
  if (settings.format !== "openai-completions") {
    throw new Error("Only OpenAI-compatible provider settings are wired for this test page.");
  }
  return {
    api: "openai-completions",
    baseUrl: settings.baseUrl || undefined,
    apiKey,
    model: settings.model || undefined,
    provider: settings.provider || undefined,
    reasoning: settings.reasoning,
    retryAttempts: settings.retryAttempts,
    retryDelayMs: settings.retryDelayMs,
    retryBackoff: settings.retryBackoff
  };
}

function normalizeFormat(value: unknown): ProviderFormat {
  return value === "anthropic-messages" || value === "google-generative-ai" || value === "openai-completions"
    ? value
    : "openai-completions";
}

function normalizeReasoning(value: unknown): ApeironLlmOptions["reasoning"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function defaultProviderForFormat(format: ProviderFormat): string {
  if (format === "anthropic-messages") {
    return "apeiron-anthropic-compatible";
  }
  if (format === "google-generative-ai") {
    return "apeiron-google-compatible";
  }
  return "apeiron-openai-compatible";
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
