import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  deltaKinds,
  echoTool,
  engineBinary,
  engineFetch,
  subscribeEngineEvents,
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

  it("interrupts a running turn before moving and runs the next bb call at the new directory", async () => {
    const { model, engine, live, startThread, startTurn, request } = ctx;
    const dirB = join(engine.root, "while-running");
    mkdirSync(dirB, { recursive: true });
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "hold" } });
    const providerThreadId = await startThread("thread-env-active");
    await startTurn("thread-env-active", providerThreadId, "call the echo tool and hold");
    await waitUntil(() => collectToolCalls(live).length === 1, "claimed call before move");
    const held = live.toolCalls[0];
    const subscription = subscribeEngineEvents(engine);
    const resumed = await request("thread/resume", {
      threadId: "thread-env-active",
      cwd: dirB,
      providerThreadId,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [echoTool],
    });
    expect(resumed.error).toBeUndefined();
    await waitUntil(
      () => subscription.events.some((event) => event.type === "session.execution.interrupted"),
      "native turn interrupted",
    );
    const info = payloadOf(await engineFetch(engine, `/api/session/${providerThreadId}`));
    process.stderr.write(`\nLIVE interrupted move: ${JSON.stringify(info.location ?? info)}\n`);
    expect(JSON.stringify(info.location ?? info)).toContain(JSON.stringify(dirB));
    expect(
      deltaKinds(live, "thread-env-active").some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "interrupted",
      ),
    ).toBe(true);
    await subscription.stop();
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "after" } },
      { kind: "text", text: "after done" },
    );
    await startTurn("thread-env-active", providerThreadId, "call the echo tool after the interrupted move");
    await waitUntil(
      () => collectToolCalls(live).some((call) => call.id !== held.id),
      "bb call at the new directory",
    );
    const next = live.toolCalls.find((call) => call.id !== held.id);
    if (next === undefined) throw new Error("missing bb call after move");
    answerToolCall(live, next, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: after" }],
    });
    await waitUntil(
      () => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: after"),
      "round trip after interrupted move",
    );
    const after = payloadOf(await engineFetch(engine, `/api/session/${providerThreadId}`));
    expect(JSON.stringify(after.location ?? after)).toContain(JSON.stringify(dirB));
  }, 180_000);
});
