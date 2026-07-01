import assert from "node:assert/strict";
import test from "node:test";
import { completeJsonWithRetry } from "../dist/llm/provider.js";

test("completeJsonWithRetry retries HTML gateway error pages before parsing JSON", async () => {
  let calls = 0;
  const retries = [];
  const client = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        return '<html lang="en"><head><title>无法连接到服务器</title></head><body>524 timeout</body></html>';
      }
      return '{"action":"final","answer":"ok"}';
    }
  };

  const result = await completeJsonWithRetry(
    client,
    [{ role: "user", content: "return json" }],
    { retryAttempts: 2, retryDelayMs: 0 },
    (event) => retries.push(event)
  );

  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].category, "network");
  assert.deepEqual(result.parsed, { action: "final", answer: "ok" });
  assert.equal(result.raw, '{"action":"final","answer":"ok"}');
});

test("completeJsonWithRetry does not retry ordinary non-JSON model text", async () => {
  let calls = 0;
  const client = {
    async complete() {
      calls += 1;
      return "I cannot produce JSON right now.";
    }
  };

  await assert.rejects(
    completeJsonWithRetry(
      client,
      [{ role: "user", content: "return json" }],
      { retryAttempts: 2, retryDelayMs: 0 }
    ),
    /LLM response did not contain a JSON object/
  );
  assert.equal(calls, 1);
});
