import fs from "node:fs/promises";
import * as vscode from "vscode";
import type { RefreshTarget } from "@apeiron/core";

export async function pickRefreshTargets(): Promise<RefreshTarget[] | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      JSON: ["json"]
    },
    title: "Select Apeiron refresh targets JSON"
  });
  const uri = selected?.[0];
  if (!uri) {
    return undefined;
  }
  const content = (await fs.readFile(uri.fsPath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(content) as unknown;
  const targets = Array.isArray(parsed) ? parsed : (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    throw new Error("Targets JSON must be an array or an object with a targets array.");
  }
  return targets as RefreshTarget[];
}
