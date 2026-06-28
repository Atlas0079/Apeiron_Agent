import * as vscode from "vscode";

export function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Apeiron requires an open VS Code workspace folder.");
  }
  return folder.uri.fsPath;
}
