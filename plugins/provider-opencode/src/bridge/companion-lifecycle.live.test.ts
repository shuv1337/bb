import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeJsonRpcObject } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { describe, expect, it } from "vitest";
import { BB_TOOL_OUTCOME_UNKNOWN } from "./bridge.js";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  deltaKinds,
  echoTool,
  engineAppId,
  engineBinary,
  engineFetch,
  engineRpc,
  password,
  startLiveBridge,
  subscribeEngineEvents,
  toolMessages,
  waitUntil,
  type Engine,
  type LiveBridge,
  type ToolCallRequest,
} from "./companion-engine.live-harness.js";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";

const LATE_REPLY = "LATE_REPLY_MUST_NOT_REACH_MODEL";
const OWNER_REPLACED = "bb tool call failed: owner replaced";
const OUTCOME_UNKNOWN_REPLACED = "bb tool outcome unknown: owner replaced while the call was claimed";

describe.skipIf(engineBinary === undefined)("OpenCode companion lifecycle", () => {
  const ctx = createLiveContext();

  it("settles a claimed call on thread/stop interrupt and reattaches on resume", async () => {
    const { model, engine, live, startThread, startTurn, request } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "hold" } });
    const providerThreadId = await startThread("thread-interrupt");
    const capability = live.capability("thread-interrupt");
    await startTurn("thread-interrupt", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const stopped = await request("thread/stop", {
      threadId: "thread-interrupt",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: openTurnId(live, "thread-interrupt"),
    });
    expect(stopped.error).toBeUndefined();
    await waitUntil(
      () => cancelledIds(live).includes(call.id),
      "notifications/cancelled for the reverse call",
    );
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: LATE_REPLY }],
    });
    const retained = await request("turn/start", {
      threadId: "thread-interrupt",
      providerThreadId,
      input: [{ type: "text", text: "should not run", mentions: [] }],
      clientRequestId: "creq_23456789ad",
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(JSON.stringify(retained.error)).toContain("No active OpenCode session");
    const resumed = await request("thread/resume", {
      threadId: "thread-interrupt",
      cwd: engine.workspace,
      providerThreadId,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [echoTool],
    });
    expect(resumed.error).toBeUndefined();
    expect(live.capability("thread-interrupt")).toEqual(expect.any(String));
    expect(live.capability("thread-interrupt")).not.toBe(capability);
    await waitIdle(engine, providerThreadId);
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "again" } },
      { kind: "text", text: "next done" },
    );
    await startTurn("thread-interrupt", providerThreadId, "call the echo tool again");
    const next = await claimedCall(live, call.id);
    expect(seenByModel(model.requests, BB_TOOL_OUTCOME_UNKNOWN)).toBe(true);
    answerToolCall(live, next, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: again" }],
    });
    await waitUntil(() => seenByModel(model.requests, "echo: again"), "resumed turn round trip");
    expect(toolNames(model.requests.at(-1))).toContain("bb_echo");
    expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
    process.stderr.write(
      `\nLIVE interrupt settlement: ${BB_TOOL_OUTCOME_UNKNOWN}\nLIVE cancelled requestId: ${String(call.id)}\n`,
    );
  }, 180_000);

  it("cancels a claimed call when another client interrupts the native session", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "native" } });
    const subscription = subscribeEngineEvents(engine);
    const providerThreadId = await startThread("thread-native-interrupt");
    const capability = live.capability("thread-native-interrupt");
    await startTurn("thread-native-interrupt", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const interrupted = await nativeInterrupt(engine, providerThreadId);
    process.stderr.write(`\nLIVE native interrupt response: ${JSON.stringify(interrupted)}\n`);
    await waitUntil(
      () => cancelledIds(live).includes(call.id),
      "notifications/cancelled after native interrupt",
    );
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: LATE_REPLY }],
    });
    await waitIdle(engine, providerThreadId);
    const failure = subscription.events.find(
      (event) => event.type === "session.tool.failed" || event.type === "session.execution.interrupted",
    );
    process.stderr.write(`\nLIVE native interrupt evidence: ${JSON.stringify(failure)}\n`);
    expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
    expect(seenByModel(model.requests, "echo: native")).toBe(false);
    expect(JSON.stringify(failure)).toContain("Tool execution interrupted");
    expect(live.capability("thread-native-interrupt")).toBe(capability);
    await subscription.stop();
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "after-native" } },
      { kind: "text", text: "native next done" },
    );
    await startTurn("thread-native-interrupt", providerThreadId, "call the echo tool after native interrupt");
    const next = await claimedCall(live, call.id);
    answerToolCall(live, next, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: after-native" }],
    });
    await waitUntil(() => seenByModel(model.requests, "echo: after-native"), "turn after native interrupt");
    expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
  }, 180_000);

  it("releases a claimed call on thread/stop and reattaches on resume", async () => {
    const { model, engine, live, startThread, startTurn, request } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "stopping" } });
    const providerThreadId = await startThread("thread-stop");
    const capability = live.capability("thread-stop");
    expect(capability).toEqual(expect.any(String));
    await startTurn("thread-stop", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const stopped = await request("thread/stop", {
      threadId: "thread-stop",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    expect(stopped.error).toBeUndefined();
    await waitUntil(() => cancelledIds(live).includes(call.id), "notifications/cancelled on stop");
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: LATE_REPLY }],
    });
    const retained = await request("turn/start", {
      threadId: "thread-stop",
      providerThreadId,
      input: [{ type: "text", text: "should not run", mentions: [] }],
      clientRequestId: "creq_23456789ab",
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(JSON.stringify(retained.error)).toContain("No active OpenCode session");
    const resumed = await request("thread/resume", {
      threadId: "thread-stop",
      cwd: engine.workspace,
      providerThreadId,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [echoTool],
    });
    expect(resumed.error).toBeUndefined();
    const nextCapability = live.capability("thread-stop");
    expect(nextCapability).toEqual(expect.any(String));
    expect(nextCapability).not.toBe(capability);
    const fenced = await engineRpc(engine, "pending", { capability });
    expect(fenced.status).not.toBe(200);
    expect(fenced.body).toContain("unbound");
    expect(
      deltaKinds(live, "thread-stop").some(
        (delta) => delta.kind === "provider.warning" && String(delta.summary).includes("does not run bb plugin tools"),
      ),
    ).toBe(false);
    await waitIdle(engine, providerThreadId);
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "resumed" } },
      { kind: "text", text: "resume done" },
    );
    await startTurn("thread-stop", providerThreadId, "call the echo tool after resume");
    const next = await claimedCall(live, call.id);
    expect(seenByModel(model.requests, BB_TOOL_OUTCOME_UNKNOWN)).toBe(true);
    answerToolCall(live, next, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: resumed" }],
    });
    await waitUntil(() => seenByModel(model.requests, "echo: resumed"), "reconstructed turn round trip");
    expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
    expect(toolNames(model.requests.at(-1))).toContain("bb_echo");
    process.stderr.write(
      `\nLIVE release detaches; next turn is thread/resume. engine=${engineAppId}\n`,
    );
  }, 180_000);

  it("does not close the turn when resync runs during a claimed call", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "resync" } },
      { kind: "text", text: "after resync" },
    );
    const providerThreadId = await startThread("thread-resync");
    await startTurn("thread-resync", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const before = deltaKinds(live, "thread-resync").length;
    await live.injectResync("thread-resync");
    const during = deltaKinds(live, "thread-resync").slice(before);
    expect(during.some((delta) => delta.kind === "turn.boundary" && delta.status === "completed")).toBe(false);
    expect(live.warnings.some((warning) => warning.includes("bb tool call still open"))).toBe(true);
    answerToolCall(live, call, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: resync" }],
    });
    await waitUntil(() => seenByModel(model.requests, "echo: resync"), "result delivered after resync");
    expect(
      deltaKinds(live, "thread-resync")
        .slice(before)
        .some((delta) => delta.kind === "turn.boundary" && delta.status === "completed" && !seenByModel(model.requests, "echo: resync")),
    ).toBe(false);
    expect(toolMessages(model.requests.find((request) => seenByModel([request], "echo: resync")) ?? { messages: [] }).join("\n")).toContain(
      "echo: resync",
    );
  }, 180_000);

  it("keeps event processing and a second session moving while a call is claimed", async () => {
    const { model, live, startThread, startTurn, request } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "blocked" } });
    const providerThreadId = await startThread("thread-blocked");
    await startTurn("thread-blocked", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    const other = await startThread("thread-other");
    await startTurn("thread-other", other, "finish without waiting");
    await waitUntil(
      () => model.requests.some((item) => JSON.stringify(item.messages).includes("finish without waiting")),
      "second session model request",
    );
    expect(live.answered.has(call.id)).toBe(false);
    const startedAt = Date.now();
    const stopped = await request("thread/stop", {
      threadId: "thread-blocked",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: openTurnId(live, "thread-blocked"),
    });
    const elapsedMs = Date.now() - startedAt;
    expect(stopped.error).toBeUndefined();
    expect(elapsedMs).toBeLessThan(8_000);
    process.stderr.write(`\nLIVE interrupt returned in ${elapsedMs}ms while a call was claimed\n`);
    expect(model.requests.some((item) => JSON.stringify(item.messages).includes("finish without waiting"))).toBe(true);
    expect(live.answered.has(call.id)).toBe(false);
  }, 180_000);

  it("fences a restarted bridge's attach and does not redispatched the claimed call", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "takeover" } },
      { kind: "text", text: "after takeover" },
      { kind: "tool", name: "bb_echo", args: { text: "new-owner" } },
      { kind: "text", text: "new owner done" },
    );
    const providerThreadId = await startThread("thread-takeover");
    const capability = live.capability("thread-takeover");
    expect(capability).toEqual(expect.any(String));
    await startTurn("thread-takeover", providerThreadId, "call the echo tool and wait");
    const call = await claimedCall(live);
    await waitUntil(
      () => existsSync(join(engine.root, "bridge-data", "opencode-session-owners.json")),
      "owners file",
    );
    const restarted = await startLiveBridge(engine);
    try {
      const resumed = await send(restarted, "thread/resume", {
        threadId: "thread-takeover",
        cwd: engine.workspace,
        providerThreadId,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [echoTool],
      });
      expect(resumed.error).toBeUndefined();
      await waitUntil(
        () => seenByModel(model.requests, OUTCOME_UNKNOWN_REPLACED),
        "uncertain takeover settlement",
      );
      expect(seenByModel(model.requests, OWNER_REPLACED)).toBe(false);
      answerToolCall(live, call, {
        success: true,
        contentItems: [{ type: "inputText", text: LATE_REPLY }],
      });
      const pending = await engineRpc(engine, "pending", { capability });
      const claim = await engineRpc(engine, "claim", { capability, key: "stale" });
      const result = await engineRpc(engine, "result", {
        capability,
        key: "stale",
        success: true,
        contentItems: [{ type: "inputText", text: "nope" }],
      });
      expect(pending.body).toContain("unbound");
      expect(claim.body).toContain("unbound");
      expect(result.body).toContain("unbound");
      expect(collectToolCalls(restarted).some((item) => item.params.callId === call.params.callId)).toBe(false);
      expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
      await waitIdle(engine, providerThreadId);
      const restartedTurn = await send(restarted, "turn/start", {
        threadId: "thread-takeover",
        providerThreadId,
        input: [{ type: "text", text: "call the echo tool as the new owner", mentions: [] }],
        clientRequestId: "creq_23456789ac",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(restartedTurn.error).toBeUndefined();
      const next = await claimedCall(restarted);
      expect(next.params.callId).not.toBe(call.params.callId);
      answerToolCall(restarted, next, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: new-owner" }],
      });
      await waitUntil(() => seenByModel(model.requests, "echo: new-owner"), "new owner round trip");
      expect(collectToolCalls(restarted)).toHaveLength(1);
      expect(seenByModel(model.requests, LATE_REPLY)).toBe(false);
      process.stderr.write(
        `\nLIVE takeover settlement: ${OUTCOME_UNKNOWN_REPLACED}\nLIVE old capability unbound on ${engineAppId}\n`,
      );
    } finally {
      await restarted.teardown();
    }
  }, 180_000);
});

function cancelledIds(live: LiveBridge): Array<string | number> {
  const ids: Array<string | number> = [];
  for (const message of live.rpc.messages) {
    if (message.method !== "notifications/cancelled") continue;
    const params = message.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) continue;
    const requestId = params.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") ids.push(requestId);
  }
  return ids;
}

function openTurnId(live: LiveBridge, threadId: string): string {
  const open = [...deltaKinds(live, threadId)].reverse().find(
    (delta) => delta.kind === "turn.open" && typeof delta.providerTurnId === "string",
  );
  if (open === undefined || typeof open.providerTurnId !== "string") {
    throw new Error(`no open turn for ${threadId}`);
  }
  return open.providerTurnId;
}

async function claimedCall(live: LiveBridge, except?: string | number): Promise<ToolCallRequest> {
  await waitUntil(
    () => collectToolCalls(live).some((call) => call.id !== except),
    "reverse item/tool/call",
  );
  const call = collectToolCalls(live).find((item) => item.id !== except);
  if (call === undefined) throw new Error("missing reverse item/tool/call");
  return call;
}

function seenByModel(
  requests: Array<{ messages: Array<{ role: string; content?: unknown }> }>,
  text: string,
): boolean {
  return requests.some((request) => JSON.stringify(request.messages).includes(text));
}

function toolNames(request: { tools?: Array<{ function?: { name?: string } }> } | undefined): string[] {
  return request?.tools?.flatMap((tool) => (tool.function?.name === undefined ? [] : [tool.function.name])) ?? [];
}

async function waitIdle(engine: Engine, sessionID: string): Promise<void> {
  await waitUntil(async () => {
    const info = (await engineFetch(engine, `/api/session/${sessionID}`)) as { status?: { type?: string } };
    return info.status?.type !== "busy";
  }, "session idle");
}

async function nativeInterrupt(engine: Engine, sessionID: string): Promise<unknown> {
  const response = await fetch(new URL(`/api/session/${sessionID}/interrupt`, engine.url), {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`interrupt -> ${response.status}: ${text}`);
  return text.length === 0 ? null : JSON.parse(text);
}

let requestSerial = 400;

async function send(
  live: LiveBridge,
  method: string,
  params: BridgeJsonRpcObject,
): Promise<{ error?: unknown; result?: unknown }> {
  requestSerial += 1;
  const id = requestSerial;
  live.rpc.sendRequest(id, method, params);
  return live.rpc.waitForResponse(id);
}
