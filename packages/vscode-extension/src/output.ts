import * as vscode from "vscode";

export class ApeironOutput {
  private readonly channel = vscode.window.createOutputChannel("Apeiron");

  show(): void {
    this.channel.show(true);
  }

  appendJson(title: string, value: unknown): void {
    this.channel.appendLine(`\n## ${title}`);
    this.channel.appendLine(JSON.stringify(value, null, 2));
  }

  appendSummary(title: string, lines: string[]): void {
    this.channel.appendLine(`\n## ${title}`);
    for (const line of lines) {
      this.channel.appendLine(line);
    }
  }

  appendError(title: string, error: unknown): void {
    this.channel.appendLine(`\n## ${title}`);
    this.channel.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
  }

  dispose(): void {
    this.channel.dispose();
  }
}
