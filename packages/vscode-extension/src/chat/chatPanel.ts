import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  appendSessionContextPack,
  appendSessionEvent,
  createContextItem,
  createContextPack,
  createWorkInputQueue,
  createRefreshTargetsFromGitStatus,
  getBlockingTurn,
  getApeironWorkspaceState,
  getGitStatus,
  inspectCoverage,
  readLatestSessionContextPack,
  readInventory,
  readSessionCheckpoints,
  readSessionEvents,
  readSessionIndex,
  readWarmupStatus,
  revalidateContextPack,
  runLlmRefresh,
  runLlmWarmup,
  runLlmWork,
  createPiAiClient,
  type ApeironCheckpointSummary,
  type ApeironSessionUiSnapshot,
  type ApeironSessionIndexEntry,
  type ContextItem,
  type ContextPack,
  type RefreshTarget,
  type WorkInputQueue,
  type WorkRunResult
} from "@apeiron/core";
import { getWorkspaceRoot } from "../workspace.js";
import {
  addContextItem,
  applyContextPackToState,
  contextItemsForRun,
  contextPriorityPaths,
  imageAttachmentsForRun,
  recalculateContextTotals,
  setContextItemsFromPack,
  toggleContextItem
} from "./contextState.js";
import { renderHtml } from "./renderHtml.js";
import {
  clearProviderApiKey,
  readProviderSettings,
  resolveProviderLlmOptions,
  writeProviderSettings
} from "./providerSettings.js";
import type { AttachmentRecord, ChatMessage, ChatState, ChatToolCall, QueuedInput, WebviewMessage } from "./types.js";
import {
  isImage,
  isMemoryPath,
  isRuntimeApeironPath,
  mimeTypeForImage,
  normalizeUiRepoPath,
  summarizeText,
  summarizeToolCall,
  summarizeToolEvent,
  summarizeToolResult,
  trimText
} from "./utils.js";

export class ApeironChatPanel {
  static current: ApeironChatPanel | undefined;

  static open(context: vscode.ExtensionContext): ApeironChatPanel {
    if (ApeironChatPanel.current) {
      ApeironChatPanel.current.panel.reveal(vscode.ViewColumn.One);
      void ApeironChatPanel.current.refreshState();
      return ApeironChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("apeironChat", "Apeiron", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    ApeironChatPanel.current = new ApeironChatPanel(context, panel);
    return ApeironChatPanel.current;
  }

  private readonly state: ChatState;
  private running = false;
  private activeRunQueue: WorkInputQueue | undefined;
  private activeAbortController: AbortController | undefined;
  private activeAssistantMessage: ChatMessage | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    const workspaceRoot = getWorkspaceRoot();
    this.state = {
      phase: "idle",
      workspaceRoot,
      statusText: "Idle",
      model: process.env.APEIRON_MODEL ?? "default",
      contextItems: [],
      contextBudgetTokens: 0,
      contextTokensEstimate: 0,
      sessions: [],
      checkpoints: [],
      codeChanges: [],
      memoryChanges: [],
      coverage: [],
      messages: [],
      events: [],
      queue: [],
      attachments: [],
      excludedContextIds: [],
      coverageFilter: "",
      abortRequested: false,
      providerSettings: {
        format: "openai-completions",
        baseUrl: "",
        model: "",
        provider: "apeiron-openai-compatible",
        reasoning: undefined,
        retryAttempts: 3,
        retryDelayMs: 1000,
        retryBackoff: 2,
        hasApiKey: false
      },
      warmupStatus: null
    };
    this.panel.webview.html = renderHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      ApeironChatPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    void this.refreshState();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        await this.refreshState();
        return;
      }
      if (message.type === "send") {
        await this.runWork(message.text);
        return;
      }
      if (message.type === "warmup") {
        await this.runWarmup(message.mode, message.goal);
        return;
      }
      if (message.type === "abort") {
        this.abortActiveRun();
        return;
      }
      if (message.type === "saveProviderSettings") {
        await this.saveProviderSettings(message.settings);
        return;
      }
      if (message.type === "clearProviderApiKey") {
        await this.clearProviderApiKey();
        return;
      }
      if (message.type === "testProviderSettings") {
        await this.testProviderSettings();
        return;
      }
      if (message.type === "queue") {
        this.queueInput(message.text, message.mode);
        return;
      }
      if (message.type === "refreshTurn") {
        await this.refreshCurrentTurn();
        return;
      }
      if (message.type === "createContext") {
        await this.createContext(message.task);
        return;
      }
      if (message.type === "toggleContext") {
        this.toggleContext(message.id, message.included);
        return;
      }
      if (message.type === "selectCoverage") {
        await this.selectCoverage(message.path);
        return;
      }
      if (message.type === "addCoverageToContext") {
        await this.addFileToContext(message.path);
        return;
      }
      if (message.type === "openSummary") {
        await this.openSummaryForFile(message.path);
        return;
      }
      if (message.type === "addFileToContext") {
        await this.pickFileForContext();
        return;
      }
      if (message.type === "selectSession") {
        await this.selectSession(message.id);
        return;
      }
      if (message.type === "selectCheckpoint") {
        await this.selectCheckpoint(message.sessionId, message.checkpointId);
        return;
      }
      if (message.type === "openChanges") {
        await this.openChanges(message.scope);
        return;
      }
      if (message.type === "openDiff") {
        await this.openDiff(message.path);
        return;
      }
      if (message.type === "uploadAttachment") {
        await this.uploadAttachment();
        return;
      }
      if (message.type === "setCoverageFilter") {
        this.state.coverageFilter = message.filter;
        this.postState();
        return;
      }
      if (message.type === "editMessage") {
        this.editMessage(message.id);
        return;
      }
      if (message.type === "openSource") {
        await this.openSource(message.path);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async refreshState(): Promise<void> {
    const workspaceState = await getApeironWorkspaceState(this.state.workspaceRoot);
    this.state.providerSettings = await readProviderSettings(this.context);
    this.state.warmupStatus = await readWarmupStatus(this.state.workspaceRoot);
    await this.restoreContextPackIfNeeded();
    this.state.sessions = await readSessionIndex(this.state.workspaceRoot);
    this.state.checkpoints = this.state.sessionId ? await readSessionCheckpoints(this.state.workspaceRoot, this.state.sessionId) : [];
    await this.refreshGitChangeBuckets();
    this.state.coverage = workspaceState.coverage
      ? Object.entries(workspaceState.coverage.reconciledInventory.files)
          .map(([filePath, entry]) => ({
            path: filePath,
            kind: entry.kind,
            status: entry.status,
            summaryRef: entry.summaryRef,
            reason: entry.reason,
            purpose: entry.purpose,
            lastReadAt: entry.lastReadAt,
            lastRefreshAt: entry.lastRefreshAt
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
      : [];
    this.state.blockingTurn = workspaceState.blockingTurn ?? undefined;
    if (workspaceState.error) {
      this.state.phase = "error";
      this.state.statusText = workspaceState.error;
    } else if (!workspaceState.initialized) {
      this.state.phase = "idle";
      this.state.statusText = "Needs warmup";
      this.state.turnId = undefined;
      this.state.refreshStatus = workspaceState.coverageStatus;
    } else if (workspaceState.blockingTurn) {
      this.state.phase = "blocked";
      this.state.statusText = `Blocked on refresh: ${workspaceState.blockingTurn.id}`;
      this.state.turnId = workspaceState.blockingTurn.id;
      this.state.refreshStatus = workspaceState.blockingTurn.refreshStatus;
    } else if (this.state.phase === "blocked" || this.state.phase === "error") {
      this.state.phase = "idle";
      this.state.statusText = `Coverage ${workspaceState.coverageStatus}`;
      this.state.turnId = undefined;
      this.state.refreshStatus = workspaceState.coverageStatus;
    } else if (this.state.phase === "idle") {
      this.state.statusText = `Coverage ${workspaceState.coverageStatus}`;
      this.state.refreshStatus = workspaceState.coverageStatus;
    }
    this.postState();
  }

  private async refreshGitChangeBuckets(): Promise<void> {
    const status = await getGitStatus(this.state.workspaceRoot).catch(() => undefined);
    const changedPaths = status?.changes.map((change) => change.path) ?? [];
    this.state.memoryChanges = changedPaths.filter((repoPath) => isMemoryPath(repoPath)).sort();
    this.state.codeChanges = changedPaths.filter((repoPath) => !isRuntimeApeironPath(repoPath)).sort();
  }

  private async selectSession(sessionId: string): Promise<void> {
    const events = await readSessionEvents(this.state.workspaceRoot, sessionId);
    this.state.sessionId = sessionId;
    this.state.messages = [];
    this.state.events = [];
    this.state.contextPack = undefined;
    this.state.contextItems = [];
    this.state.contextBudgetTokens = 0;
    this.state.contextTokensEstimate = 0;
    for (const event of events) {
      if (event.type === "message") {
        this.state.messages.push({
          id: `session-${sessionId}-message-${this.state.messages.length}`,
          role: event.role,
          content: event.content,
          createdAt: event.createdAt
        });
      } else if (event.type === "context-pack") {
        this.state.contextPack = event.contextPack;
      } else if (event.type === "tool-event") {
        this.addEvent(event.event.type, summarizeToolEvent(event.event), event.event);
      } else if (event.type === "refresh-result") {
        this.addEvent("refresh-result", `Refresh checked ${event.result.checked.length} target(s)`, event.result);
      } else if (event.type === "turn") {
        this.addEvent("turn", `Turn ${event.turn.phase}: ${event.turn.refreshStatus}`, event.turn);
        this.state.turnId = event.turn.id;
        this.state.refreshStatus = event.turn.refreshStatus;
      } else if (event.type === "phase") {
        this.addEvent("phase", event.summary, event);
      }
    }
    if (this.state.contextPack) {
      const revalidated = await revalidateContextPack(this.state.workspaceRoot, this.state.contextPack);
      this.state.contextPack = revalidated;
      this.state.contextItems = revalidated.items;
      this.state.contextBudgetTokens = revalidated.budgetTokens;
      this.state.contextTokensEstimate = revalidated.tokensEstimate;
    }
    this.state.checkpoints = await readSessionCheckpoints(this.state.workspaceRoot, sessionId);
    this.state.phase = "idle";
    this.state.statusText = `Loaded session ${sessionId}`;
    this.postState();
  }

  private async selectCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const events = await readSessionEvents(this.state.workspaceRoot, sessionId);
    const checkpoints = await readSessionCheckpoints(this.state.workspaceRoot, sessionId);
    const checkpoint = checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) {
      return;
    }
    if (checkpoint.snapshot) {
      this.restoreUiSnapshot(checkpoint.snapshot);
      this.state.sessionId = undefined;
      this.state.turnId = undefined;
      this.state.refreshStatus = undefined;
      this.state.checkpoints = checkpoints;
      this.state.phase = "idle";
      this.state.statusText = `Restored checkpoint ${checkpoint.label}`;
      const lastUserMessage = this.state.messages.filter((message) => message.role === "user").at(-1);
      if (lastUserMessage) {
        this.panel.webview.postMessage({ type: "editMessage", text: lastUserMessage.content });
      }
      this.addEvent("checkpoint", `Restored ${checkpoint.label}`, checkpoint);
      this.postState();
      return;
    }
    this.state.sessionId = undefined;
    this.state.turnId = undefined;
    this.state.refreshStatus = undefined;
    this.state.messages = [];
    this.state.events = [];
    this.state.contextPack = undefined;
    let messageCount = 0;
    for (const event of events) {
      if (event.type === "message") {
        messageCount += 1;
        if (messageCount > checkpoint.messageIndex) {
          break;
        }
        this.state.messages.push({
          id: `checkpoint-${checkpoint.id}-message-${this.state.messages.length}`,
          role: event.role,
          content: event.content,
          createdAt: event.createdAt
        });
      } else if (event.type === "context-pack" && messageCount <= checkpoint.messageIndex) {
        this.state.contextPack = event.contextPack;
      } else if (event.type === "tool-event" && messageCount <= checkpoint.messageIndex) {
        this.addEvent(event.event.type, summarizeToolEvent(event.event), event.event);
      }
    }
    if (this.state.contextPack) {
      const revalidated = await revalidateContextPack(this.state.workspaceRoot, this.state.contextPack);
      this.state.contextPack = revalidated;
      this.state.contextItems = revalidated.items;
      this.state.contextBudgetTokens = revalidated.budgetTokens;
      this.state.contextTokensEstimate = revalidated.tokensEstimate;
    }
    const lastUserMessage = this.state.messages.filter((message) => message.role === "user").at(-1);
    if (lastUserMessage) {
      this.panel.webview.postMessage({ type: "editMessage", text: lastUserMessage.content });
      this.addMessage("system", "Checkpoint restored. Editing and sending this prompt will start a new session from the restored context.");
    }
    this.state.checkpoints = checkpoints;
    this.state.phase = "idle";
    this.state.statusText = `Restored checkpoint ${checkpoint.label}`;
    this.addEvent("checkpoint", `Restored ${checkpoint.label}`, checkpoint);
    this.postState();
  }

  private async runWork(text: string): Promise<void> {
    const task = text.trim();
    if (!task || this.running) {
      return;
    }
    this.running = true;
    const abortController = this.startAbortableRun();
    this.activeAssistantMessage = undefined;
    const userMessage = this.addMessage("user", task);
    this.state.phase = "work";
    this.state.statusText = "Running work agent";
    this.postState();

    try {
      const liveInputQueue = createWorkInputQueue(this.consumeQueuedInputs());
      this.activeRunQueue = liveInputQueue;
      const result = await runLlmWork({
        workspaceRoot: this.state.workspaceRoot,
        task,
        contextPack: this.state.contextPack,
        contextItemsOverride: await this.contextItemsForRun(task),
        liveInputQueue,
        imageAttachments: imageAttachmentsForRun(this.state),
        priorityPaths: contextPriorityPaths(this.state),
        maxTurns: 12,
        abortSignal: abortController.signal,
        onToolEvent: (event) => {
          this.addEvent(event.tool, summarizeToolEvent(event), event);
          this.appendToolToActiveMessage(event);
        },
        onCommentary: (commentary) => this.appendAgentCommentary(commentary),
        onLlmRetry: (event) => {
          this.addEvent("llm-retry", `Retrying LLM request ${event.attempt}/${event.maxAttempts}`, event);
          this.appendLlmRetryToActiveMessage(event);
        },
        onRefreshToolEvent: (event) => this.addEvent(`refresh:${event.tool}`, summarizeMemoryToolEvent(event), event),
        llmOptions: await resolveProviderLlmOptions(this.context)
      });
      this.applyWorkResult(result);
      const assistantMessage = this.appendAgentCommentary(result.answer);
      this.addEvent("turn", `Turn ${result.turn.phase}: ${result.turn.refreshStatus}`, result.turn);
      this.state.sessionId = result.sessionId;
      this.state.turnId = result.turn.id;
      this.state.refreshStatus = result.turn.refreshStatus;
      await this.refreshGitChangeBuckets();
      assistantMessage.codeChanges = [...this.state.codeChanges];
      assistantMessage.memoryChanges = [...this.state.memoryChanges];
      this.state.phase = result.turn.phase === "blocked" ? "blocked" : "done";
      this.state.statusText = result.turn.phase === "blocked" ? "Blocked until refresh completes" : "Done";
      await this.persistLatestCheckpointSnapshot();
      await this.refreshState();
    } catch (error) {
      const wasAborted = error instanceof Error && error.message === "Apeiron run aborted";
      this.reportError(error);
      if (!wasAborted) {
        this.addEvent("error", "Work failed", { error: this.state.statusText, userMessage });
      }
    } finally {
      this.running = false;
      this.activeRunQueue = undefined;
      this.activeAssistantMessage = undefined;
      this.finishAbortableRun(abortController);
      this.postState();
    }
  }

  private async runWarmup(mode: "full" | "scoped", goal: string): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const abortController = this.startAbortableRun();
    this.activeAssistantMessage = undefined;
    this.addMessage("assistant", `${mode === "full" ? "Full" : "Scoped"} warmup started.`);
    this.state.phase = "warmup";
    this.state.statusText = "Running warmup agent";
    this.addEvent("phase", `Warmup ${mode} started`, { mode, goal });
    this.postState();
    try {
      const result = await runLlmWarmup({
        workspaceRoot: this.state.workspaceRoot,
        mode,
        goal,
        maxTurns: mode === "full" ? 50 : 30,
        abortSignal: abortController.signal,
        onToolEvent: (event) => {
          this.addEvent(`warmup:${event.tool}`, summarizeMemoryToolEvent(event), event);
          this.appendMemoryToolToActiveMessage(event);
        },
        onCommentary: (commentary) => this.appendAgentCommentary(commentary),
        onLlmRetry: (event) => {
          this.addEvent("llm-retry", `Retrying LLM request ${event.attempt}/${event.maxAttempts}`, event);
          this.appendLlmRetryToActiveMessage(event);
        },
        llmOptions: await resolveProviderLlmOptions(this.context)
      });
      this.appendAgentCommentary(`Warmup complete. Documented ${result.documentedFiles.length} file(s); ${result.unreadFiles} unread file(s) remain.`);
      this.addEvent("warmup-result", `Warmup documented ${result.documentedFiles.length} file(s)`, result);
      this.state.phase = result.blocked.length > 0 ? "blocked" : "done";
      this.state.statusText = result.blocked.length > 0 ? "Warmup blocked" : "Warmup complete";
      if (result.blocked.length === 0) {
        await this.createContext(goal);
      }
      await this.refreshState();
    } catch (error) {
      this.state.warmupStatus = await readWarmupStatus(this.state.workspaceRoot);
      this.reportError(error);
    } finally {
      this.running = false;
      this.activeAssistantMessage = undefined;
      this.finishAbortableRun(abortController);
      this.postState();
    }
  }

  private async refreshCurrentTurn(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const abortController = this.startAbortableRun();
    this.state.phase = "refresh";
    this.state.statusText = "Refreshing current turn";
    this.postState();
    try {
      const targets = await this.refreshTargetsForBlockingTurn();
      if (targets.length === 0) {
        throw new Error("No refresh targets found for the current blocked turn.");
      }
      const result = await runLlmRefresh({
        workspaceRoot: this.state.workspaceRoot,
        targets,
        abortSignal: abortController.signal,
        onToolEvent: (event) => this.addEvent(`refresh:${event.tool}`, summarizeMemoryToolEvent(event), event),
        onLlmRetry: (event) => this.addEvent("llm-retry", `Retrying refresh LLM request ${event.attempt}/${event.maxAttempts}`, event),
        llmOptions: await resolveProviderLlmOptions(this.context)
      });
      this.state.latestRefreshSummary = toRefreshSummary(result);
      this.addEvent("refresh-result", `Refresh checked ${result.checked.length} target(s)`, result);
      this.state.phase = result.blocked.length > 0 ? "blocked" : "done";
      this.state.statusText = result.blocked.length > 0 ? "Refresh blocked" : "Refresh complete";
      await this.refreshState();
    } catch (error) {
      this.reportError(error);
    } finally {
      this.running = false;
      this.finishAbortableRun(abortController);
      this.postState();
    }
  }

  private async createContext(task: string): Promise<void> {
    const inventory = await readInventory(this.state.workspaceRoot);
    if (!inventory) {
      throw new Error("Missing inventory. Run Apeiron init or warmup first.");
    }
    this.state.phase = "context";
    this.state.statusText = "Creating context pack";
    this.postState();
    const coverage = await inspectCoverage(this.state.workspaceRoot, inventory);
    const contextPack = await createContextPack({
      task: task.trim() || "Inspect current Apeiron task context.",
      workspaceRoot: this.state.workspaceRoot,
      inventory: coverage.inventory,
      coverage,
      priorityPaths: contextPriorityPaths(this.state),
      existingPack: this.state.contextPack
    });
    setContextItemsFromPack(this.state, contextPack);
    await this.persistContextPack();
    this.addEvent("context-pack", `Context pack: ${contextPack.items.length} item(s)`, contextPack);
    this.state.phase = "idle";
    this.state.statusText = "Context ready";
    this.postState();
  }

  private toggleContext(id: string, included: boolean): void {
    toggleContextItem(this.state, id, included);
    void this.persistContextPackFromState();
    this.postState();
  }

  private async saveProviderSettings(settings: Parameters<typeof writeProviderSettings>[1]): Promise<void> {
    this.state.providerSettings = await writeProviderSettings(this.context, settings);
    this.state.providerSettingsStatus = "Saved provider settings.";
    this.addEvent("settings", "Provider settings saved", {
      ...this.state.providerSettings,
      hasApiKey: this.state.providerSettings.hasApiKey
    });
    this.postState();
  }

  private async clearProviderApiKey(): Promise<void> {
    this.state.providerSettings = await clearProviderApiKey(this.context);
    this.state.providerSettingsStatus = "API key cleared.";
    this.addEvent("settings", "Provider API key cleared", { provider: this.state.providerSettings.provider });
    this.postState();
  }

  private async testProviderSettings(): Promise<void> {
    this.state.providerSettingsStatus = "Testing provider settings...";
    this.postState();
    try {
      const llmOptions = await resolveProviderLlmOptions(this.context);
      const client = createPiAiClient(llmOptions);
      const raw = await client.complete(
        [
          { role: "system", content: "Reply with exactly this JSON object and no extra text: {\"ok\":true}" },
          { role: "user", content: "Return {\"ok\":true}." }
        ],
        { maxTokens: 32 }
      );
      this.state.providerSettingsStatus = raw.includes("true") ? "Provider test succeeded." : "Provider responded, but not with expected text.";
      this.addEvent("settings", "Provider test completed", { response: raw });
    } catch (error) {
      this.state.providerSettingsStatus = error instanceof Error ? error.message : String(error);
      this.addEvent("settings", "Provider test failed", { error: this.state.providerSettingsStatus });
    }
    this.postState();
  }

  private async selectCoverage(repoPath: string): Promise<void> {
    const node = this.state.coverage.find((item) => item.path === repoPath);
    if (!node) {
      return;
    }
    this.state.selectedCoverage = node;
    this.postState();
  }

  private async openSummaryForFile(repoPath: string): Promise<void> {
    const node = this.state.coverage.find((item) => item.path === repoPath) ?? this.state.selectedCoverage;
    if (!node?.summaryRef) {
      vscode.window.showInformationMessage(`No summaryRef for ${repoPath}.`);
      return;
    }
    const summaryPath = node.summaryRef.split("#", 1)[0];
    await this.openSource(summaryPath);
  }

  private async pickFileForContext(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      title: "Add files to Apeiron context",
      defaultUri: vscode.Uri.file(this.state.workspaceRoot)
    });
    if (!selected?.length) {
      return;
    }
    for (const uri of selected) {
      const relative = path.relative(this.state.workspaceRoot, uri.fsPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      await this.addFileToContext(normalizeUiRepoPath(relative));
    }
  }

  private async addFileToContext(repoPath: string): Promise<void> {
    const absolutePath = path.join(this.state.workspaceRoot, ...repoPath.split("/"));
    const content = await fs.readFile(absolutePath, "utf8");
    const item = createContextItem({
      type: "file",
      source: repoPath,
      title: `Pinned file: ${repoPath}`,
      summary: summarizeText(content),
      content: trimText(content, 8000),
      enabled: true,
      pinned: true,
      autoAdded: false,
      addedBy: "user",
      reason: "User added this file to the context pack."
    });
    addContextItem(this.state, item);
    await this.persistContextPack();
    this.addMessage("system", `Added file to context:\n${repoPath}`, {
      attachments: [{
        id: `context-file-${Date.now()}-${repoPath}`,
        name: path.basename(repoPath),
        kind: "text",
        path: repoPath,
        preview: summarizeText(content)
      }]
    });
    this.addEvent("context-pack", `Added ${repoPath} to context`, item);
    this.postState();
  }

  private queueInput(text: string, mode: "steering" | "follow-up"): void {
    if (!text.trim()) {
      return;
    }
    const queued = {
      id: `queue-${Date.now()}`,
      mode,
      content: text.trim(),
      createdAt: new Date().toISOString()
    };
    if (this.activeRunQueue) {
      this.activeRunQueue.push(queued);
    } else {
      this.state.queue.push(queued);
    }
    this.addEvent("queued-input", this.activeRunQueue ? `${mode} injected into current work run` : `${mode} queued for next work run`, {
      mode,
      content: text.trim(),
      availableInCurrentRun: Boolean(this.activeRunQueue)
    });
    this.postState();
  }

  private async uploadAttachment(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: {
        "Supported attachments": ["txt", "md", "json", "log", "png", "jpg", "jpeg", "webp", "gif"],
        Text: ["txt", "md", "json", "log"],
        Images: ["png", "jpg", "jpeg", "webp", "gif"]
      },
      title: "Attach files to Apeiron"
    });
    if (!selected?.length) {
      return;
    }
    const sessionId = this.state.sessionId ?? "draft";
    const messageId = `message-${Date.now()}`;
    const targetDir = path.join(this.state.workspaceRoot, ".apeiron", "attachments", sessionId, messageId);
    await fs.mkdir(targetDir, { recursive: true });
    for (const uri of selected) {
      const fileName = path.basename(uri.fsPath);
      const targetPath = path.join(targetDir, fileName);
      await fs.copyFile(uri.fsPath, targetPath);
      const kind = isImage(fileName) ? "image" : "text";
      const imageData = kind === "image" ? await readImageData(targetPath) : undefined;
      const preview = kind === "text" ? await readTextPreview(targetPath) : undefined;
      this.state.attachments.push({
        id: `attachment-${Date.now()}-${fileName}`,
        name: fileName,
        kind,
        path: targetPath,
        messageId,
        preview,
        data: imageData?.data,
        mimeType: imageData?.mimeType
      });
      if (preview) {
        this.state.contextItems.push(createContextItem({
          type: "attachment",
          title: fileName,
          summary: preview.slice(0, 500),
          source: targetPath,
          enabled: true,
          pinned: true,
          autoAdded: false,
          addedBy: "user",
          reason: "User attached this text file to the conversation.",
          content: preview
        }));
      } else {
        this.state.contextItems.push(createContextItem({
          type: "attachment",
          title: fileName,
          summary: "Image attachment will be passed to the model on the next work run if the configured model/provider accepts image input.",
          source: targetPath,
          enabled: true,
          pinned: true,
          autoAdded: false,
          addedBy: "user",
          reason: "User attached this image to the conversation.",
          content: `[image attachment: ${fileName}]`,
          validity: "current"
        }));
      }
    }
    this.addMessage("system", `Attached file(s):\n${selected.map((uri) => path.basename(uri.fsPath)).join("\n")}`, {
      attachments: this.state.attachments.slice(-selected.length)
    });
    this.addEvent("attachment", `Attached ${selected.length} file(s)`, this.state.attachments.slice(-selected.length));
    recalculateContextTotals(this.state);
    void this.persistContextPackFromState();
    this.postState();
  }

  private editMessage(id: string): void {
    const message = this.state.messages.find((item) => item.id === id && item.role === "user");
    if (!message) {
      return;
    }
    this.panel.webview.postMessage({ type: "editMessage", text: message.content });
  }

  private async openSource(repoPath: string): Promise<void> {
    const absolutePath = path.isAbsolute(repoPath) ? repoPath : path.join(this.state.workspaceRoot, ...repoPath.split("/"));
    const document = await vscode.workspace.openTextDocument(absolutePath);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async openChanges(scope: "all" | "code" | "memory"): Promise<void> {
    const paths = scope === "memory" ? this.state.memoryChanges : scope === "code" ? this.state.codeChanges : [];
    if (paths.length === 1) {
      await this.openDiff(paths[0]);
      return;
    }
    await vscode.commands.executeCommand("workbench.view.scm");
    if (scope !== "all" && paths.length === 0) {
      vscode.window.showInformationMessage(`No ${scope} changes found.`);
    }
  }

  private async openDiff(repoPath: string): Promise<void> {
    const normalized = normalizeUiRepoPath(repoPath);
    const absolutePath = path.join(this.state.workspaceRoot, ...normalized.split("/"));
    const currentUri = vscode.Uri.file(absolutePath);
    const exists = await fs.stat(absolutePath).then((stat) => stat.isFile()).catch(() => false);
    if (!exists) {
      await vscode.commands.executeCommand("workbench.view.scm");
      return;
    }
    const headUri = currentUri.with({
      scheme: "git",
      query: JSON.stringify({ path: currentUri.fsPath, ref: "HEAD" })
    });
    await vscode.commands.executeCommand("vscode.diff", headUri, currentUri, `Apeiron Diff: ${normalized}`);
  }

  private applyWorkResult(result: WorkRunResult): void {
    this.state.contextItems = result.contextPack.items.map((item) => ({
      ...item,
      included: item.enabled && !this.state.excludedContextIds.includes(item.id),
      enabled: item.enabled && !this.state.excludedContextIds.includes(item.id)
    }));
    this.state.contextBudgetTokens = result.contextPack.budgetTokens;
    this.state.contextTokensEstimate = result.contextPack.tokensEstimate;
    this.state.contextPack = result.contextPack;
    if (result.refreshResult) {
      this.state.latestRefreshSummary = toRefreshSummary(result.refreshResult);
      this.addEvent("refresh-result", `Auto refresh checked ${result.refreshResult.checked.length} target(s)`, result.refreshResult);
    }
  }

  private async refreshTargetsForBlockingTurn(): Promise<RefreshTarget[]> {
    const blocking = await getBlockingTurn(this.state.workspaceRoot);
    if (blocking?.refreshTargets.length) {
      return blocking.refreshTargets.map((repoPath) => ({
        path: repoPath,
        kinds: blocking.deletedFiles.includes(repoPath)
          ? ["deleted"]
          : blocking.createdFiles.includes(repoPath)
            ? ["created"]
            : blocking.modifiedFiles.includes(repoPath)
              ? ["modified"]
              : ["read"],
        priority: blocking.modifiedFiles.includes(repoPath) || blocking.createdFiles.includes(repoPath) || blocking.deletedFiles.includes(repoPath)
          ? "must-refresh"
          : "opportunistic",
        reason: `blocked turn ${blocking.id} requires refresh`
      }));
    }
    const status = await getGitStatus(this.state.workspaceRoot);
    return await createRefreshTargetsFromGitStatus(status, this.state.workspaceRoot);
  }

  private async contextItemsForRun(task: string): Promise<ContextItem[]> {
    if (this.state.contextItems.length === 0) {
      await this.createContext(task);
    }
    return contextItemsForRun(this.state);
  }

  private consumeQueuedInputs(): QueuedInput[] {
    const queued = [...this.state.queue];
    this.state.queue = [];
    return queued;
  }

  private addMessage(
    role: ChatMessage["role"],
    content: string,
    extras: Partial<Pick<ChatMessage, "attachments" | "codeChanges" | "memoryChanges">> = {}
  ): ChatMessage {
    const message = {
      id: `message-${Date.now()}-${this.state.messages.length}`,
      role,
      content,
      createdAt: new Date().toISOString(),
      ...extras
    };
    this.state.messages.push(message);
    this.postState();
    return message;
  }

  private appendAgentCommentary(content: string): ChatMessage {
    const trimmed = content.trim();
    if (!trimmed) {
      return this.activeAssistantMessage ?? this.createToolPlaceholderMessage();
    }
    this.activeAssistantMessage = this.addMessage("assistant", trimmed);
    return this.activeAssistantMessage;
  }

  private appendToolToActiveMessage(event: { type: string; tool: string; path?: string; query?: string; command?: string; ok?: boolean; error?: string; exitCode?: number | null; resultCount?: number }): void {
    const message = this.activeAssistantMessage ?? this.createToolPlaceholderMessage();
    const tool = toolViewFromTrackedEvent(event);
    if (!tool) {
      return;
    }
    message.tools = [...(message.tools ?? []), tool];
    this.postState();
  }

  private appendMemoryToolToActiveMessage(event: { type: string; tool: string; input?: unknown; result?: unknown }): void {
    const message = this.activeAssistantMessage ?? this.createToolPlaceholderMessage();
    const tool = toolViewFromMemoryEvent(event);
    if (!tool) {
      return;
    }
    message.tools = [...(message.tools ?? []), tool];
    this.postState();
  }

  private appendLlmRetryToActiveMessage(event: { attempt: number; maxAttempts: number; delayMs: number; category: string; message: string }): void {
    const message = this.activeAssistantMessage ?? this.createToolPlaceholderMessage();
    message.tools = [...(message.tools ?? []), {
      id: `retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: `retry LLM request ${event.attempt}/${event.maxAttempts}`,
      status: "running",
      detail: `${event.category}; waiting ${event.delayMs}ms`
    }];
    this.postState();
  }

  private createToolPlaceholderMessage(): ChatMessage {
    this.activeAssistantMessage = this.addMessage("assistant", "Working...");
    return this.activeAssistantMessage;
  }

  private addEvent(kind: string, summary: string, detail: unknown): void {
    this.state.events.push({
      id: `event-${Date.now()}-${this.state.events.length}`,
      kind,
      summary,
      detail,
      createdAt: new Date().toISOString()
    });
    this.postState();
  }

  private startAbortableRun(): AbortController {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.state.abortRequested = false;
    return abortController;
  }

  private finishAbortableRun(abortController: AbortController): void {
    if (this.activeAbortController === abortController) {
      this.activeAbortController = undefined;
    }
    this.state.abortRequested = false;
  }

  private abortActiveRun(): void {
    if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
      return;
    }
    this.state.abortRequested = true;
    this.state.statusText = "Stop requested";
    this.activeAbortController.abort();
    this.addEvent("abort", "Stop requested", { phase: this.state.phase });
    this.postState();
  }

  private async restoreContextPackIfNeeded(): Promise<void> {
    if (this.state.contextPack || !this.state.sessionId) {
      return;
    }
    const contextPack = await readLatestSessionContextPack(this.state.workspaceRoot, this.state.sessionId);
    if (!contextPack) {
      return;
    }
    const revalidated = await revalidateContextPack(this.state.workspaceRoot, contextPack);
    applyContextPackToState(this.state, revalidated);
    await this.persistContextPack();
  }

  private async persistContextPack(): Promise<void> {
    if (!this.state.contextPack || !this.state.sessionId) {
      return;
    }
    await appendSessionContextPack(this.state.workspaceRoot, { id: this.state.sessionId, path: `.apeiron/sessions/${this.state.sessionId}.jsonl` }, this.state.contextPack);
  }

  private async persistContextPackFromState(): Promise<void> {
    if (!this.state.contextPack) {
      return;
    }
    recalculateContextTotals(this.state);
    await this.persistContextPack();
  }

  private createUiSnapshot(): ApeironSessionUiSnapshot {
    return {
      version: 1,
      messages: this.state.messages,
      attachments: this.state.attachments,
      codeChanges: this.state.codeChanges,
      memoryChanges: this.state.memoryChanges,
      contextPack: this.state.contextPack,
      latestRefreshSummary: this.state.latestRefreshSummary
    };
  }

  private restoreUiSnapshot(snapshot: ApeironSessionUiSnapshot): void {
    this.state.messages = isArrayOfObjects(snapshot.messages) ? snapshot.messages as ChatMessage[] : [];
    this.state.attachments = isArrayOfObjects(snapshot.attachments) ? snapshot.attachments as AttachmentRecord[] : [];
    this.state.codeChanges = snapshot.codeChanges ?? [];
    this.state.memoryChanges = snapshot.memoryChanges ?? [];
    this.state.contextPack = snapshot.contextPack;
    this.state.latestRefreshSummary = snapshot.latestRefreshSummary as ChatState["latestRefreshSummary"];
    if (snapshot.contextPack) {
      applyContextPackToState(this.state, snapshot.contextPack);
    } else {
      this.state.contextItems = [];
      this.state.contextBudgetTokens = 0;
      this.state.contextTokensEstimate = 0;
    }
  }

  private async persistLatestCheckpointSnapshot(): Promise<void> {
    if (!this.state.sessionId) {
      return;
    }
    const checkpoints = await readSessionCheckpoints(this.state.workspaceRoot, this.state.sessionId);
    const checkpoint = checkpoints.at(-1);
    if (!checkpoint || checkpoint.hasSnapshot) {
      return;
    }
    await appendSessionEvent(this.state.workspaceRoot, { id: this.state.sessionId, path: `.apeiron/sessions/${this.state.sessionId}.jsonl` }, {
      type: "checkpoint-snapshot",
      checkpointId: checkpoint.id,
      snapshot: this.createUiSnapshot(),
      createdAt: new Date().toISOString()
    });
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Apeiron run aborted") {
      this.state.phase = "done";
      this.state.statusText = "Stopped";
      this.addEvent("abort", "Run stopped", { stopped: true });
      this.postState();
      return;
    }
    this.state.phase = "error";
    this.state.statusText = message;
    this.addEvent("error", message, { error: message });
    this.postState();
  }

  private postState(): void {
    void this.panel.webview.postMessage({ type: "state", state: this.state });
  }
}

async function readTextPreview(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return content.length > 12000 ? `${content.slice(0, 12000)}\n[truncated]` : content;
}

function isArrayOfObjects(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object");
}

function toolViewFromTrackedEvent(event: {
  type: string;
  tool: string;
  path?: string;
  query?: string;
  command?: string;
  ok?: boolean;
  error?: string;
  exitCode?: number | null;
  resultCount?: number;
}): ChatToolCall | null {
  if (event.type === "tool-call") {
    return {
      id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: summarizeToolEvent(event),
      status: "running",
      detail: toolTarget(event)
    };
  }
  if (event.type === "tool-result") {
    const failed = event.ok === false || (event.tool === "run_command" && event.exitCode !== 0);
    return {
      id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: summarizeToolEvent(event),
      status: failed ? "failed" : "ok",
      detail: toolTarget(event)
    };
  }
  return null;
}

function toolViewFromMemoryEvent(event: { type: string; tool: string; input?: unknown; result?: unknown }): ChatToolCall | null {
  if (event.type === "tool-call") {
    return {
      id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: summarizeMemoryToolEvent(event),
      status: "running",
      detail: memoryToolTarget(event.input)
    };
  }
  if (event.type === "tool-result") {
    const result = event.result as { ok?: boolean; error?: string } | undefined;
    return {
      id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: summarizeMemoryToolEvent(event),
      status: result?.ok === false || Boolean(result?.error) ? "failed" : "ok",
      detail: memoryToolTarget(event.result)
    };
  }
  return null;
}

function toolTarget(event: { path?: string; query?: string; command?: string }): string | undefined {
  return event.path ?? event.query ?? event.command;
}

function memoryToolTarget(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = value as { path?: unknown; query?: unknown; pattern?: unknown };
  if (typeof input.path === "string") {
    return input.path;
  }
  if (typeof input.query === "string") {
    return input.query;
  }
  if (typeof input.pattern === "string") {
    return input.pattern;
  }
  return undefined;
}

function summarizeMemoryToolEvent(event: { type: string; tool: string; input?: unknown; result?: unknown }): string {
  if (event.type === "tool-call") {
    const input = event.input as { path?: string; query?: string } | undefined;
    if (input?.path) {
      return `${event.tool}: ${input.path}`;
    }
    if (input?.query) {
      return `${event.tool}: ${input.query}`;
    }
    return event.tool;
  }
  const result = event.result as { path?: string; ok?: boolean; error?: string } | undefined;
  if (result?.path) {
    return `${event.tool} ${result.ok === false ? "failed" : "ok"}: ${result.path}`;
  }
  if (result?.error) {
    return `${event.tool} failed`;
  }
  return `${event.tool} result`;
}

function toRefreshSummary(result: WorkRunResult["refreshResult"] extends infer T ? NonNullable<T> : never) {
  return {
    checked: result.checked.length,
    updatedMemoryFiles: result.updatedMemoryFiles,
    updatedSummaries: result.updatedSummaries,
    blocked: result.blocked,
    memoryDiffFiles: result.memoryDiffSummary.files.map((file) => file.path)
  };
}

async function readImageData(filePath: string): Promise<{ data: string; mimeType: string }> {
  const bytes = await fs.readFile(filePath);
  return {
    data: bytes.toString("base64"),
    mimeType: mimeTypeForImage(filePath)
  };
}
