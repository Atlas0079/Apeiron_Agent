import assert from "node:assert/strict";
import test from "node:test";
import { resolveApeironConfig } from "../dist/config.js";

test("resolveApeironConfig defaults warmup expansion to never", () => {
  assert.deepEqual(resolveApeironConfig(), {
    autoExpandWarmup: "never",
    maxWarmupExpansionFilesPerRun: 20
  });
});

test("resolveApeironConfig allows explicit warmup expansion policy", () => {
  assert.deepEqual(resolveApeironConfig({ autoExpandWarmup: "always" }), {
    autoExpandWarmup: "always",
    maxWarmupExpansionFilesPerRun: 20
  });
});
