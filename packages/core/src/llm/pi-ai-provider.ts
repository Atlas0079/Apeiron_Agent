import {
  completeSimple,
  type Api,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";
import type { ApeironLlmClient, ApeironLlmMessage, ApeironLlmOptions } from "./provider.js";

export function createPiAiClient(defaults: ApeironLlmOptions = {}): ApeironLlmClient {
  return {
    async complete(messages, options = {}) {
      const merged = resolveOptions({ ...defaults, ...options });
      const model = createOpenAICompletionsModel(merged, messagesHaveImages(messages));
      const response = await completeSimple(model, toPiContext(messages), toPiOptions(merged));
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `LLM request failed with stopReason=${response.stopReason}`);
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!text.trim()) {
        throw new Error("LLM response did not include text content");
      }
      return text;
    }
  };
}

function resolveOptions(options: ApeironLlmOptions): Required<Pick<ApeironLlmOptions, "api" | "baseUrl" | "apiKey" | "model">> &
  ApeironLlmOptions {
  const api = options.api ?? "openai-completions";
  if (api !== "openai-completions") {
    throw new Error(`Unsupported APEIRON_MODEL_API: ${api}`);
  }
  if (!options.baseUrl) {
    throw new Error("Missing APEIRON_OPENAI_BASE_URL");
  }
  if (!options.apiKey) {
    throw new Error("Missing APEIRON_OPENAI_API_KEY");
  }
  if (!options.model) {
    throw new Error("Missing APEIRON_MODEL");
  }
  return { ...options, api, baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model };
}

function createOpenAICompletionsModel(options: ReturnType<typeof resolveOptions>, supportsImages: boolean): Model<"openai-completions"> {
  return {
    id: options.model,
    name: options.model,
    api: "openai-completions",
    provider: options.provider ?? "apeiron-openai-compatible",
    baseUrl: options.baseUrl,
    reasoning: Boolean(options.reasoning),
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128000,
    maxTokens: options.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens"
    }
  };
}

function toPiContext(messages: ApeironLlmMessage[]): Context {
  const piMessages: Message[] = [];
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .join("\n\n");

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "user") {
      piMessages.push({ role: "user", content: toPiUserContent(message.content), timestamp: Date.now() });
      continue;
    }
    piMessages.push({
      role: "assistant",
      content: [{ type: "text", text: contentToText(message.content) }],
      api: "openai-completions" as Api,
      provider: "apeiron-openai-compatible",
      model: "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });
  }

  return {
    systemPrompt: systemPrompt || undefined,
    messages: piMessages
  };
}

function toPiUserContent(content: ApeironLlmMessage["content"]): string | Array<TextContent | ImageContent> {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return { type: "image", data: part.data, mimeType: part.mimeType };
  });
}

function contentToText(content: ApeironLlmMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function messagesHaveImages(messages: ApeironLlmMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
}

function toPiOptions(options: ReturnType<typeof resolveOptions>): SimpleStreamOptions {
  return {
    apiKey: options.apiKey,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 4096,
    reasoning: options.reasoning
  };
}
