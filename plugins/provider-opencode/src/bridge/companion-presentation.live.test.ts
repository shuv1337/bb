import { describe, expect, it } from "vitest";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  deltaKinds,
  engineBinary,
  engineFetch,
  subscribeEngineEvents,
  waitUntil,
  type Engine,
  type LiveBridge,
  type ToolCallRequest,
} from "./companion-engine.live-harness.js";

const PRESENTATION = {
  label: { pending: "Echoing", completed: "Echoed" },
  icon: { glyph: "Workflow" },
  tint: { light: "#abc", dark: "#123" },
  suppress: true,
};

const echoTool = {
  name: "bb_echo",
  description: "Echo text back through bb.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  presentation: PRESENTATION,
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toolRows(live: LiveBridge, threadId: string, callId?: string) {
  return deltaKinds(live, threadId).filter((delta) => {
    if (delta.kind !== "item.open" && delta.kind !== "item.close") return false;
    const item = record(delta.item);
    if (item?.tool !== "bb_echo" || item.server !== "bb") return false;
    if (callId === undefined) return true;
    return record(delta.key)?.providerItemId === callId;
  });
}

async function claimedCall(live: LiveBridge): Promise<ToolCallRequest> {
  await waitUntil(() => collectToolCalls(live).length > 0, "reverse item/tool/call");
  const call = collectToolCalls(live)[0];
  if (call === undefined) throw new Error("missing reverse item/tool/call");
  return call;
}

async function nativeInterrupt(engine: Engine, sessionID: string): Promise<void> {
  await engineFetch(engine, `/api/session/${sessionID}/interrupt`, { method: "POST" });
}

describe.skipIf(engineBinary === undefined)("OpenCode companion presentation", () => {
  const ctx = createLiveContext();

  it("emits one bb row per call with the canonical name and supplied presentation", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "hello" } },
      { kind: "text", text: "done" },
    );
    const providerThreadId = await startThread("thread-present", { dynamicTools: [echoTool] });
    await startTurn("thread-present", providerThreadId, "call the echo tool");
    const call = await claimedCall(live);
    const callId = String(call.params.callId);
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: hello" }],
    });
    await waitUntil(() => {
      const rows = toolRows(live, "thread-present", callId);
      return rows.some((delta) => delta.kind === "item.close" && delta.status === "completed");
    }, "bb row closed");
    const rows = toolRows(live, "thread-present", callId);
    expect(rows.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    expect(rows[0]).toMatchObject({
      item: { type: "tool", server: "bb", tool: "bb_echo" },
      presentation: PRESENTATION,
    });
    expect(rows[1]).toMatchObject({
      status: "completed",
      item: { type: "tool", server: "bb", tool: "bb_echo" },
      presentation: PRESENTATION,
    });
    expect(collectToolCalls(live)).toHaveLength(1);
  }, 120_000);

  it("closes a failed bb call with the error text and does not add a second row", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "boom" } },
      { kind: "text", text: "done" },
    );
    const subscription = subscribeEngineEvents(engine);
    const providerThreadId = await startThread("thread-present-fail", { dynamicTools: [echoTool] });
    await startTurn("thread-present-fail", providerThreadId, "call the echo tool and fail");
    const call = await claimedCall(live);
    const callId = String(call.params.callId);
    answerToolCall(live, call, {
      success: false,
      contentItems: [{ type: "inputText", text: "first failure block" }],
    });
    await waitUntil(() => {
      const rows = toolRows(live, "thread-present-fail", callId);
      return rows.some((delta) => delta.kind === "item.close" && delta.status === "failed");
    }, "failed bb row");
    const failed = subscription.events.find(
      (event) => event.type === "session.tool.failed" && event.data?.id === callId,
    );
    process.stderr.write(`\nLIVE presentation failure: ${JSON.stringify(failed)}\n`);
    const rows = toolRows(live, "thread-present-fail", callId);
    expect(rows.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    expect(rows[1]).toMatchObject({
      status: "failed",
      item: { server: "bb", tool: "bb_echo" },
    });
    expect(JSON.stringify(rows[1])).toContain("first failure block");
    await subscription.stop();
  }, 120_000);

  it("closes an interrupted bb call as interrupted", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "stop" } });
    const providerThreadId = await startThread("thread-present-stop", { dynamicTools: [echoTool] });
    await startTurn("thread-present-stop", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const callId = String(call.params.callId);
    const subscription = subscribeEngineEvents(engine);
    await nativeInterrupt(engine, providerThreadId);
    await waitUntil(() => {
      const rows = toolRows(live, "thread-present-stop", callId);
      return rows.some((delta) => delta.kind === "item.close" && delta.status === "interrupted");
    }, "interrupted bb row");
    const rows = toolRows(live, "thread-present-stop", callId);
    expect(rows.filter((delta) => delta.kind === "item.open")).toHaveLength(1);
    expect(rows.filter((delta) => delta.kind === "item.close" && delta.status === "interrupted")).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("Tool execution interrupted");
    const aborted = subscription.events.find(
      (event) => event.type === "session.tool.failed" && event.data?.id === callId,
    );
    process.stderr.write(`\nLIVE presentation interrupt: ${JSON.stringify(aborted)}\n`);
    await subscription.stop();
  }, 120_000);

  it("does not mark an open bb row succeeded when resync runs mid-call", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "resync" } },
      { kind: "text", text: "after" },
    );
    const providerThreadId = await startThread("thread-present-resync", { dynamicTools: [echoTool] });
    await startTurn("thread-present-resync", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const callId = String(call.params.callId);
    await waitUntil(
      () => toolRows(live, "thread-present-resync", callId).some((delta) => delta.kind === "item.open"),
      "bb row opened",
    );
    await live.injectResync("thread-present-resync");
    const during = toolRows(live, "thread-present-resync", callId);
    expect(during.some((delta) => delta.kind === "item.close")).toBe(false);
    expect(
      deltaKinds(live, "thread-present-resync").some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
      ),
    ).toBe(false);
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: resync" }],
    });
    await waitUntil(() => {
      const rows = toolRows(live, "thread-present-resync", callId);
      return rows.some((delta) => delta.kind === "item.close" && delta.status === "completed");
    }, "bb row closes after the call, not the resync");
    expect(toolRows(live, "thread-present-resync", callId).filter((delta) => delta.kind === "item.open")).toHaveLength(
      1,
    );
  }, 180_000);
});
