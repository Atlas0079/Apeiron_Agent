export interface OpenAICompatibleMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAICompatibleContentPart[];
}

export type OpenAICompatibleContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface OpenAICompatibleClient {
  complete(messages: OpenAICompatibleMessage[], options?: OpenAICompatibleOptions): Promise<string>;
}

export function createOpenAICompatibleClient(defaults: OpenAICompatibleOptions = {}): OpenAICompatibleClient {
  return {
    async complete(messages, options = {}) {
      const merged = resolveOptions({ ...defaults, ...options });
      const response = await fetch(new URL("/v1/chat/completions", ensureTrailingSlash(merged.baseUrl)), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${merged.apiKey}`
        },
        body: JSON.stringify({
          model: merged.model,
          messages: messages.map(toOpenAIMessage),
          temperature: merged.temperature ?? 0.2,
          max_tokens: merged.maxTokens ?? 4096
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM request failed: HTTP ${response.status} ${redactSecrets(text)}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response did not include choices[0].message.content");
      }
      return content;
    }
  };
}

export function readOpenAICompatibleEnv(): OpenAICompatibleOptions {
  return {
    baseUrl: process.env.APEIRON_OPENAI_BASE_URL,
    apiKey: process.env.APEIRON_OPENAI_API_KEY,
    model: process.env.APEIRON_MODEL
  };
}

export { extractJsonObject } from "./provider.js";

function toOpenAIMessage(message: OpenAICompatibleMessage): unknown {
  if (typeof message.content === "string") {
    return message;
  }
  return {
    role: message.role,
    content: message.content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.mimeType};base64,${part.data}`
        }
      };
    })
  };
}

function resolveOptions(options: OpenAICompatibleOptions): Required<Pick<OpenAICompatibleOptions, "baseUrl" | "apiKey" | "model">> &
  OpenAICompatibleOptions {
  const baseUrl = options.baseUrl;
  const apiKey = options.apiKey;
  const model = options.model;
  if (!baseUrl) {
    throw new Error("Missing APEIRON_OPENAI_BASE_URL");
  }
  if (!apiKey) {
    throw new Error("Missing APEIRON_OPENAI_API_KEY");
  }
  if (!model) {
    throw new Error("Missing APEIRON_MODEL");
  }
  return { ...options, baseUrl, apiKey, model };
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-REDACTED");
}
