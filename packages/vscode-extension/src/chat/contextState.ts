import path from "node:path";
import type { ContextItem, ContextPack, WorkImageAttachment } from "@apeiron/core";
import { updateContextPack } from "@apeiron/core";
import type { ChatState } from "./types.js";

export function createDraftContextPack(workspaceRoot: string): ContextPack {
  const now = new Date().toISOString();
  return {
    version: 1,
    task: "Draft context",
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
    coverageStatus: "needs-warmup",
    budgetTokens: 24000,
    tokensEstimate: 0,
    items: []
  };
}

export function applyContextPackToState(state: ChatState, contextPack: ContextPack): void {
  state.contextPack = contextPack;
  state.contextItems = contextPack.items;
  state.contextBudgetTokens = contextPack.budgetTokens;
  state.contextTokensEstimate = contextPack.tokensEstimate;
}

export function setContextItemsFromPack(state: ChatState, contextPack: ContextPack): void {
  state.contextPack = contextPack;
  state.contextItems = contextPack.items.map((item) => ({
    ...item,
    included: !state.excludedContextIds.includes(item.id) && item.included
  }));
  state.contextBudgetTokens = contextPack.budgetTokens;
  state.contextTokensEstimate = contextPack.tokensEstimate;
}

export function toggleContextItem(state: ChatState, id: string, included: boolean): void {
  state.contextItems = state.contextItems.map((item) => (item.id === id ? { ...item, included, enabled: included } : item));
  if (state.contextPack) {
    state.contextPack = updateContextPack(state.contextPack, { setEnabled: [{ id, enabled: included }] });
  }
  if (included) {
    state.excludedContextIds = state.excludedContextIds.filter((itemId) => itemId !== id);
  } else if (!state.excludedContextIds.includes(id)) {
    state.excludedContextIds.push(id);
  }
  recalculateContextTotals(state);
}

export function addContextItem(state: ChatState, item: ContextItem): void {
  state.contextPack = updateContextPack(state.contextPack ?? createDraftContextPack(state.workspaceRoot), { items: [item] });
  applyContextPackToState(state, state.contextPack);
}

export function contextPriorityPaths(state: ChatState): string[] {
  return state.contextItems
    .filter((item) => item.enabled && item.type === "file" && !path.isAbsolute(item.source))
    .map((item) => item.source)
    .slice(0, 20);
}

export function contextItemsForRun(state: ChatState): ContextItem[] {
  return state.contextItems.map((item) => ({
    ...item,
    included: item.included && !state.excludedContextIds.includes(item.id),
    enabled: item.enabled && !state.excludedContextIds.includes(item.id)
  }));
}

export function imageAttachmentsForRun(state: ChatState): WorkImageAttachment[] {
  const includedSources = new Set(state.contextItems.filter((item) => item.enabled).map((item) => item.source));
  return state.attachments
    .filter((attachment) => attachment.kind === "image" && attachment.data && attachment.mimeType && includedSources.has(attachment.path))
    .map((attachment) => ({
      name: attachment.name,
      data: attachment.data ?? "",
      mimeType: attachment.mimeType ?? "application/octet-stream"
    }));
}

export function recalculateContextTotals(state: ChatState): void {
  state.contextTokensEstimate = state.contextItems
    .filter((item) => item.enabled)
    .reduce((total, item) => total + (item.tokensEstimate ?? 0), 0);
  if (state.contextPack) {
    state.contextPack = {
      ...state.contextPack,
      items: state.contextItems,
      tokensEstimate: state.contextTokensEstimate,
      updatedAt: new Date().toISOString()
    };
  }
}
