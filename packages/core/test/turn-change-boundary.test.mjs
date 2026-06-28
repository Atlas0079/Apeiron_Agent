import assert from "node:assert/strict";
import test from "node:test";
import { createTurnChangeBoundary } from "../dist/agent/turn-change-boundary.js";

function status(changes) {
  return {
    branch: "main",
    gitRoot: undefined,
    changes
  };
}

function change(path, kind = "modified", indexStatus = "M", worktreeStatus = " ") {
  return {
    path,
    indexStatus,
    worktreeStatus,
    kind
  };
}

function target(path, kinds = ["read"], priority = "opportunistic") {
  return {
    path,
    kinds,
    priority,
    reason: kinds.includes("read") ? "file was read during work" : "file changed during work"
  };
}

test("ignores preexisting dirty files that were not touched during the turn", async () => {
  const result = await createTurnChangeBoundary({
    beforeStatus: status([change("src/a.ts")]),
    afterStatus: status([change("src/a.ts"), change("src/b.ts")]),
    trackedTargets: []
  });

  assert.deepEqual(result.refreshTargets.map((item) => item.path), ["src/b.ts"]);
  assert.deepEqual(result.ignoredPreexistingDirty.map((item) => item.path), ["src/a.ts"]);
});

test("keeps preexisting dirty files as touched targets without upgrading read-only work", async () => {
  const result = await createTurnChangeBoundary({
    beforeStatus: status([change("src/a.ts")]),
    afterStatus: status([change("src/a.ts")]),
    trackedTargets: [target("src/a.ts")]
  });

  assert.deepEqual(result.refreshTargets.map((item) => item.path), ["src/a.ts"]);
  assert.deepEqual(result.refreshTargets[0].kinds, ["read"]);
  assert.deepEqual(result.ignoredPreexistingDirty, []);
});

test("captures indirect git changes created during the turn", async () => {
  const result = await createTurnChangeBoundary({
    beforeStatus: status([]),
    afterStatus: status([change("src/a.ts"), change("src/b.ts")]),
    trackedTargets: [target("src/a.ts", ["modified"], "must-refresh")]
  });

  assert.deepEqual(result.refreshTargets.map((item) => item.path), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.gitDeltaTargets.map((item) => item.path), ["src/a.ts", "src/b.ts"]);
});

test("treats changed git status signature as a turn change", async () => {
  const result = await createTurnChangeBoundary({
    beforeStatus: status([change("src/a.ts", "modified", "M", " ")]),
    afterStatus: status([change("src/a.ts", "deleted", "D", " ")]),
    trackedTargets: []
  });

  assert.deepEqual(result.refreshTargets.map((item) => item.path), ["src/a.ts"]);
  assert.deepEqual(result.refreshTargets[0].kinds, ["deleted"]);
});
