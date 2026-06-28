import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { summarizeMemoryDiff } from "../dist/memory/memory-diff.js";

const execFileAsync = promisify(execFile);

test("summarizeMemoryDiff summarizes git diff for memory files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-memory-diff-"));
  await git(workspaceRoot, "init");
  await git(workspaceRoot, "config", "user.email", "apeiron@example.test");
  await git(workspaceRoot, "config", "user.name", "Apeiron Test");

  const memoryDir = path.join(workspaceRoot, ".apeiron", "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "PROJECT.md"), "# Project\n\nOld\n", "utf8");
  await git(workspaceRoot, "add", ".apeiron/memory/PROJECT.md");
  await git(workspaceRoot, "commit", "-m", "initial memory");

  await fs.writeFile(path.join(memoryDir, "PROJECT.md"), "# Project\n\nNew\nExtra\n", "utf8");

  const summary = await summarizeMemoryDiff(workspaceRoot);

  assert.equal(summary.paths[0], ".apeiron/memory");
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].path, ".apeiron/memory/PROJECT.md");
  assert.equal(summary.files[0].addedLines, 2);
  assert.equal(summary.files[0].removedLines, 1);
  assert.match(summary.diff, /diff --git/);
});

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}
