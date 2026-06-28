import assert from "node:assert/strict";
import test from "node:test";
import { fillScopedWarmupUnreadReasons } from "../dist/memory/warmup-inventory.js";

function inventory(files) {
  return {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "scoped",
      scope: ["src"],
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files
  };
}

function entry(status, reason = null) {
  return {
    kind: "runtime",
    status,
    summaryRef: null,
    purpose: "test file",
    reason,
    hash: "sha256:test",
    lastReadAt: null,
    lastRefreshAt: null
  };
}

test("fillScopedWarmupUnreadReasons marks unread files outside scoped warmup", () => {
  const original = inventory({
    "src/a.ts": entry("documented"),
    "src/b.ts": entry("unread"),
    "src/c.ts": entry("unread", "blocked")
  });

  const next = fillScopedWarmupUnreadReasons(original, ["src/a.ts"]);

  assert.equal(next.files["src/b.ts"].reason, "outside-scoped-warmup");
  assert.equal(next.files["src/c.ts"].reason, "blocked");
  assert.equal(original.files["src/b.ts"].reason, null);
});

test("fillScopedWarmupUnreadReasons uses read-deferred when there are no scope hints", () => {
  const next = fillScopedWarmupUnreadReasons(
    inventory({
      "src/a.ts": entry("unread")
    }),
    []
  );

  assert.equal(next.files["src/a.ts"].reason, "read-deferred");
});
