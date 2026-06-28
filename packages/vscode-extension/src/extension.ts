import * as vscode from "vscode";
import {
  createContextPack,
  createRefreshPlan,
  createRefreshTargetsFromGitStatus,
  getGitStatus,
  initApeiron,
  readInventory,
  runLlmRefresh,
  runLlmWarmup,
  runLlmWork,
  inspectCoverage
} from "@apeiron/core";
import { ApeironOutput } from "./output.js";
import { pickRefreshTargets } from "./targets.js";
import { getWorkspaceRoot } from "./workspace.js";
import { ApeironChatPanel } from "./chat/chatPanel.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = new ApeironOutput();
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("apeiron.openChat", () => ApeironChatPanel.open(context)),
    vscode.commands.registerCommand("apeiron.init", () => runCommand(output, "Init", runInit)),
    vscode.commands.registerCommand("apeiron.scan", () => runCommand(output, "Scan", runScan)),
    vscode.commands.registerCommand("apeiron.context", () => runCommand(output, "Create Context Pack", runContext)),
    vscode.commands.registerCommand("apeiron.refreshPlan", () => runCommand(output, "Create Refresh Plan", runRefreshPlan)),
    vscode.commands.registerCommand("apeiron.refresh", () => runCommand(output, "Refresh", runRefresh)),
    vscode.commands.registerCommand("apeiron.warmupLlm", () => runCommand(output, "Warmup LLM", runWarmupLlm)),
    vscode.commands.registerCommand("apeiron.refreshLlm", () => runCommand(output, "Refresh LLM", runRefreshLlm)),
    vscode.commands.registerCommand("apeiron.workRunLlm", () => runCommand(output, "Work Run LLM", runWorkRunLlm)),
    vscode.commands.registerCommand("apeiron.gitStatus", () => runCommand(output, "Git Status", runGitStatus)),
    vscode.commands.registerCommand("apeiron.gitRefreshTargets", () => runCommand(output, "Git Refresh Targets", runGitRefreshTargets))
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered in activate.
}

async function runCommand(
  output: ApeironOutput,
  title: string,
  command: (output: ApeironOutput) => Promise<void>
): Promise<void> {
  output.show();
  try {
    await command(output);
    await vscode.window.showInformationMessage(`Apeiron: ${title} completed.`);
  } catch (error) {
    output.appendError(`${title} failed`, error);
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function runInit(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const result = await initApeiron(workspaceRoot);
  output.appendJson("Init", { workspaceRoot, result });
}

async function runScan(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const scan = await inspectCoverage(workspaceRoot, await readInventory(workspaceRoot));
  output.appendJson("Scan", {
    workspaceRoot,
    status: scan.status,
    issueCount: scan.issues.length,
    issues: scan.issues
  });
}

async function runContext(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const task = await vscode.window.showInputBox({
    title: "Apeiron context task",
    prompt: "Describe the task that needs context preparation."
  });
  if (!task) {
    return;
  }
  const inventory = await requireInventory(workspaceRoot);
  const coverage = await inspectCoverage(workspaceRoot, inventory);
  const contextPack = await createContextPack({
    task,
    workspaceRoot,
    inventory: coverage.inventory,
    coverage
  });
  output.appendJson("Context Pack", contextPack);
}

async function runRefreshPlan(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const targets = await pickRefreshTargets();
  if (!targets) {
    return;
  }
  const inventory = await requireInventory(workspaceRoot);
  const plan = createRefreshPlan({ inventory, targets });
  output.appendJson("Refresh Plan", plan);
}

async function runRefresh(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const targets = await pickRefreshTargets();
  if (!targets) {
    return;
  }
  const result = await runLlmRefresh({ workspaceRoot, targets });
  output.appendSummary("Refresh Summary", [
    `targets: ${targets.length}`,
    `checked: ${result.checked.length}`,
    `updated memory files: ${result.updatedMemoryFiles.length}`,
    `blocked: ${result.blocked.length}`,
    `turns: ${result.turns}`
  ]);
  output.appendJson("Refresh", { workspaceRoot, result });
}

async function runWarmupLlm(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const goal = await vscode.window.showInputBox({
    title: "Apeiron scoped warmup goal",
    prompt: "Describe what the agent should understand. It will infer the scoped boundary from code evidence.",
    value: "Understand the current task area."
  });
  if (goal === undefined) {
    return;
  }
  const scopeInput = await vscode.window.showInputBox({
    title: "Apeiron warmup path hints",
    prompt: "Optional repo path hints, separated by commas. These are hints, not hard boundaries.",
    value: ""
  });
  if (scopeInput === undefined) {
    return;
  }
  const maxFilesInput = await vscode.window.showInputBox({
    title: "Apeiron LLM warmup max files",
    prompt: "Maximum files to include in this scoped warmup.",
    value: "20",
    validateInput(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive number.";
    }
  });
  if (maxFilesInput === undefined) {
    return;
  }
  const scope = scopeInput
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const result = await runLlmWarmup({
    workspaceRoot,
    mode: "scoped",
    goal,
    scope,
    maxFiles: Number(maxFilesInput)
  });
  output.appendJson("Warmup LLM", { workspaceRoot, result });
}

async function runRefreshLlm(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const targets = await pickRefreshTargets();
  if (!targets) {
    return;
  }
  const result = await runLlmRefresh({ workspaceRoot, targets });
  output.appendSummary("Refresh LLM Summary", [
    `targets: ${targets.length}`,
    `checked: ${result.checked.length}`,
    `updated memory files: ${result.updatedMemoryFiles.length}`,
    `blocked: ${result.blocked.length}`,
    `turns: ${result.turns}`
  ]);
  output.appendJson("Refresh LLM", { workspaceRoot, result });
}

async function runWorkRunLlm(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const task = await vscode.window.showInputBox({
    title: "Apeiron work task",
    prompt: "Describe the coding task. The agent may read, search, edit files, and run commands."
  });
  if (!task) {
    return;
  }
  const priorityInput = await vscode.window.showInputBox({
    title: "Apeiron work priority paths",
    prompt: "Optional repo paths, separated by commas.",
    value: ""
  });
  if (priorityInput === undefined) {
    return;
  }
  const maxTurnsInput = await vscode.window.showInputBox({
    title: "Apeiron work max turns",
    prompt: "Maximum tool turns before final answer.",
    value: "12",
    validateInput(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive number.";
    }
  });
  if (maxTurnsInput === undefined) {
    return;
  }
  const priorityPaths = priorityInput
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const result = await runLlmWork({
    workspaceRoot,
    task,
    priorityPaths,
    maxTurns: Number(maxTurnsInput)
  });
  output.appendSummary("Work Run Summary", [
    `turn: ${result.turn.id}`,
    `phase: ${result.turn.phase}`,
    `refresh: ${result.turn.refreshStatus}`,
    `refresh targets: ${result.refreshTargets.length}`,
    `tool events: ${result.events.length}`,
    `session: ${result.sessionId ?? "none"}`
  ]);
  output.appendJson("Work Run LLM", { workspaceRoot, result });
}

async function runGitStatus(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const status = await getGitStatus(workspaceRoot);
  output.appendJson("Git Status", { workspaceRoot, status });
}

async function runGitRefreshTargets(output: ApeironOutput): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const status = await getGitStatus(workspaceRoot);
  const targets = await createRefreshTargetsFromGitStatus(status, workspaceRoot);
  output.appendJson("Git Refresh Targets", { workspaceRoot, targets });
}

async function requireInventory(workspaceRoot: string) {
  const inventory = await readInventory(workspaceRoot);
  if (!inventory) {
    throw new Error("Missing .apeiron/memory/inventory.json. Run Apeiron: Init first.");
  }
  return inventory;
}
