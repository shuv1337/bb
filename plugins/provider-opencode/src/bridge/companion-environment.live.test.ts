import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  echoTool,
  engineBinary,
  engineFetch,
  toolMessages,
  waitUntil,
} from "./companion-engine.live-harness.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return isRecord(raw.data) ? raw.data : raw;
}

describe.skipIf(engineBinary === undefined)("OpenCode companion environment migration", () => {
  const ctx = createLiveContext();

  it("resumes a bb thread in a new directory and round-trips a bb call there", async () => {
    const { model, engine, live, startThread, startTurn, request } = ctx;
    const dirB = join(engine.root, "elsewhere");
    mkdirSync(dirB, { recursive: true });
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "moved" } },
      { kind: "text", text: "moved done" },
    );
    const providerThreadId = await startThread("thread-env");
    const resumed = await request("thread/resume", {
      threadId: "thread-env",
      cwd: dirB,
      providerThreadId,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [echoTool],
    });
    expect(resumed.error).toBeUndefined();
    const info = payloadOf(await engineFetch(engine, `/api/session/${providerThreadId}`));
    const location = isRecord(info.location) ? info.location : info;
    process.stderr.write(`\nLIVE moved session: ${JSON.stringify(info.location ?? info)}\n`);
    expect(JSON.stringify(location)).toContain(JSON.stringify(dirB));
    await startTurn("thread-env", providerThreadId, "call the echo tool after the move");
    await waitUntil(() => collectToolCalls(live).length === 1, "bb call after move");
    answerToolCall(live, live.toolCalls[0], {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: moved" }],
    });
    await waitUntil(() => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: moved"), "moved round trip");
    const after = payloadOf(await engineFetch(engine, `/api/session/${providerThreadId}`));
    expect(JSON.stringify(after.location ?? after)).toContain(JSON.stringify(dirB));
  }, 180_000);
});
