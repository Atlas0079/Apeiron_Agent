#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { runLlmWork } from "./agent/work-runner.js";
import { createContextPack } from "./memory/context-pack.js";
import { inspectCoverage } from "./memory/coverage.js";
import { readInventory } from "./memory/inventory.js";
import { getMemoryDiff, summarizeMemoryDiff } from "./memory/memory-diff.js";
import { createRefreshPlan } from "./memory/refresh-plan.js";
import { runLlmRefresh } from "./memory/refresh-runner.js";
import type { RefreshTarget } from "./memory/refresh-targets.js";
import { initApeiron } from "./memory/store.js";
import { runLlmWarmup } from "./memory/warmup-runner.js";
import { createRefreshTargetsFromGitStatus, getGitDiff, getGitStatus } from "./repo/git.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "init") {
    const workspaceRoot = path.resolve(args[0] ?? process.cwd());
    const result = await initApeiron(workspaceRoot);
    console.log(JSON.stringify({ command, workspaceRoot, ...result }, null, 2));
    return;
  }

  if (command === "scan") {
    const workspaceRoot = path.resolve(args[0] ?? process.cwd());
    const scan = await inspectCoverage(workspaceRoot, await readInventory(workspaceRoot));
    console.log(
      JSON.stringify(
        {
          command,
          workspaceRoot,
          status: scan.status,
          issueCount: scan.issues.length,
          issues: scan.issues
        },
        null,
        2
      )
    );
    return;
  }

  if (command === "context") {
    const { values, flags } = parseArgs(args);
    const task = values[0];
    if (!task) {
      throw new Error("context requires a task string");
    }
    const workspaceRoot = path.resolve(values[1] ?? process.cwd());
    const inventory = await requireInventory(workspaceRoot);
    const coverage = await inspectCoverage(workspaceRoot, inventory);
    const priorityPaths = flags.priority ?? [];
    const contextPack = await createContextPack({
      task,
      workspaceRoot,
      inventory: coverage.inventory,
      coverage,
      priorityPaths
    });
    console.log(JSON.stringify(contextPack, null, 2));
    return;
  }

  if (command === "refresh-plan") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const targetsPath = flags.targets?.[0];
    if (!targetsPath) {
      throw new Error("refresh-plan requires --targets <json-file>");
    }
    const inventory = await requireInventory(workspaceRoot);
    const targets = await readTargetsJson(path.resolve(workspaceRoot, targetsPath));
    const plan = createRefreshPlan({ inventory, targets });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === "refresh") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const targetsPath = flags.targets?.[0];
    if (!targetsPath) {
      throw new Error("refresh requires --targets <json-file>");
    }
    const targets = await readTargetsJson(path.resolve(workspaceRoot, targetsPath));
    const result = await runLlmRefresh({ workspaceRoot, targets });
    console.log(JSON.stringify({ command, workspaceRoot, result }, null, 2));
    return;
  }

  if (command === "warmup-llm") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const mode = flags.mode?.[0] === "full" ? "full" : "scoped";
    const goal = flags.goal?.[0];
    const scope = flags.scopeHint ?? flags.scope ?? [];
    const maxFiles = flags.maxFiles?.[0] ? Number(flags.maxFiles[0]) : undefined;
    const result = await runLlmWarmup({ workspaceRoot, mode, goal, scope, maxFiles });
    console.log(JSON.stringify({ command, workspaceRoot, result }, null, 2));
    return;
  }

  if (command === "refresh-llm") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const targetsPath = flags.targets?.[0];
    if (!targetsPath) {
      throw new Error("refresh-llm requires --targets <json-file>");
    }
    const targets = await readTargetsJson(path.resolve(workspaceRoot, targetsPath));
    const result = await runLlmRefresh({ workspaceRoot, targets });
    console.log(JSON.stringify({ command, workspaceRoot, result }, null, 2));
    return;
  }

  if (command === "work-run") {
    const { values, flags } = parseArgs(args);
    const task = values[0];
    if (!task) {
      throw new Error("work-run requires a task string");
    }
    const workspaceRoot = path.resolve(values[1] ?? process.cwd());
    const result = await runLlmWork({
      workspaceRoot,
      task,
      priorityPaths: flags.priority ?? [],
      maxTurns: flags.maxTurns?.[0] ? Number(flags.maxTurns[0]) : undefined,
      maxSearchResults: flags.maxSearchResults?.[0] ? Number(flags.maxSearchResults[0]) : undefined,
      maxReadBytes: flags.maxReadBytes?.[0] ? Number(flags.maxReadBytes[0]) : undefined,
      commandTimeoutMs: flags.commandTimeoutMs?.[0] ? Number(flags.commandTimeoutMs[0]) : undefined,
      autoRefresh: !("noRefresh" in flags),
      persistSession: !("noSession" in flags)
    });
    console.log(JSON.stringify({ command, workspaceRoot, result }, null, 2));
    return;
  }

  if (command === "git-status") {
    const workspaceRoot = path.resolve(args[0] ?? process.cwd());
    const status = await getGitStatus(workspaceRoot);
    console.log(JSON.stringify({ command, workspaceRoot, status }, null, 2));
    return;
  }

  if (command === "git-refresh-targets") {
    const workspaceRoot = path.resolve(args[0] ?? process.cwd());
    const status = await getGitStatus(workspaceRoot);
    const targets = await createRefreshTargetsFromGitStatus(status, workspaceRoot);
    console.log(JSON.stringify({ command, workspaceRoot, targets }, null, 2));
    return;
  }

  if (command === "git-diff") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const diff = await getGitDiff(workspaceRoot, flags.path ?? []);
    console.log(diff);
    return;
  }

  if (command === "memory-diff") {
    const { values, flags } = parseArgs(args);
    const workspaceRoot = path.resolve(values[0] ?? process.cwd());
    const paths = flags.path?.length ? flags.path : [".apeiron/memory"];
    if ("raw" in flags) {
      console.log(await getMemoryDiff(workspaceRoot, paths));
      return;
    }
    console.log(JSON.stringify(await summarizeMemoryDiff(workspaceRoot, paths), null, 2));
    return;
  }

  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.error(`Usage:
  apeiron init [workspaceRoot]
  apeiron scan [workspaceRoot]
  apeiron context "<task>" [workspaceRoot] [--priority <repoPath> ...]
  apeiron refresh-plan [workspaceRoot] --targets <json-file>
  apeiron refresh [workspaceRoot] --targets <json-file>
  apeiron warmup-llm [workspaceRoot] [--mode scoped|full] [--goal <description>] [--scopeHint <repoPath> ...] [--maxFiles <n>]
  apeiron refresh-llm [workspaceRoot] --targets <json-file>
  apeiron work-run "<task>" [workspaceRoot] [--priority <repoPath> ...] [--maxTurns <n>] [--maxSearchResults <n>] [--maxReadBytes <n>] [--commandTimeoutMs <n>] [--noRefresh] [--noSession]
  apeiron git-status [workspaceRoot]
  apeiron git-refresh-targets [workspaceRoot]
  apeiron git-diff [workspaceRoot] [--path <repoPath> ...]
  apeiron memory-diff [workspaceRoot] [--path <repoPath> ...] [--raw]`);
}

function parseArgs(args: string[]): { values: string[]; flags: Record<string, string[]> } {
  const values: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = flags[key] ?? [];
      continue;
    }
    flags[key] = [...(flags[key] ?? []), next];
    index += 1;
  }
  return { values, flags };
}

async function requireInventory(workspaceRoot: string) {
  const inventory = await readInventory(workspaceRoot);
  if (!inventory) {
    throw new Error("Missing .apeiron/memory/inventory.json. Run apeiron init first.");
  }
  return inventory;
}

async function readTargetsJson(filePath: string): Promise<RefreshTarget[]> {
  const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(content) as unknown;
  const targets = Array.isArray(parsed) ? parsed : (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    throw new Error("targets JSON must be an array or an object with a targets array");
  }
  return targets as RefreshTarget[];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
