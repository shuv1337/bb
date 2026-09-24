import { describe, expect, it } from "vitest";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  deltaKinds,
  engineBinary,
  engineFetch,
  subscribeEngineEvents,
  toolMessages,
  type Engine,
  type ModelRequest,
  type ToolCallRequest,
  waitForSessionIdle,
  waitUntil,
} from "./companion-engine.live-harness.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TURN_ENDED = "bb turn ended; bb tools are unavailable to background subagents after their owning turn";
const ORIGIN_UNKNOWN = "bb tool origin could not be established; the call was not run";
const IDENTITY_EVENTS = [
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
];
const PLAN_OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  providerOptions: { agent: "plan" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return isRecord(raw.data) ? raw.data : raw;
}

function toolNames(request: ModelRequest): string[] {
  return (request.tools ?? []).flatMap((tool) => (tool.function?.name === undefined ? [] : [tool.function.name]));
}

function toolParameters(request: ModelRequest, name: string): Record<string, unknown> | undefined {
  const match = request.tools?.find((tool) => tool.function?.name === name);
  return match?.function?.parameters;
}

function callsFor(calls: ToolCallRequest[], threadId: string): ToolCallRequest[] {
  return calls.filter((call) => call.params.threadId === threadId);
}

async function promptNative(engine: Engine, sessionID: string, text: string): Promise<void> {
  await engineFetch(engine, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

describe.skipIf(engineBinary === undefined)("OpenCode companion ownership", () => {
  const ctx = createLiveContext({ modelInput: ["text", "image"] });

  it("keeps same-name catalogs separate for two roots in one directory", async () => {
    const { model, live, startThread, startTurn } = ctx;
    const byId = {
      name: "bb_lookup",
      description: "Lookup by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
    const byQuery = {
      name: "bb_lookup",
      description: "Lookup by query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query", "limit"],
        additionalProperties: false,
      },
    };
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("catalog a lookup") && !blob.includes("found alpha")) {
        return { kind: "tool", name: "bb_lookup", args: { id: "alpha" } };
      }
      if (blob.includes("catalog b lookup") && !blob.includes("found beta")) {
        return { kind: "tool", name: "bb_lookup", args: { query: "beta", limit: 2 } };
      }
      return { kind: "text", text: "done" };
    };
    const rootA = await startThread("thread-catalog-a", { dynamicTools: [byId] });
    const rootB = await startThread("thread-catalog-b", { dynamicTools: [byQuery] });
    await startTurn("thread-catalog-a", rootA, "catalog a lookup");
    await waitUntil(() => callsFor(collectToolCalls(live), "thread-catalog-a").length === 1, "catalog a call");
    const requestA = model.requests.find((request) => JSON.stringify(request.messages).includes("catalog a lookup"));
    expect(requestA).toBeDefined();
    expect(toolNames(requestA ?? { messages: [] })).toContain("bb_lookup");
    expect(toolNames(requestA ?? { messages: [] }).some((name) => name.startsWith("bbt_"))).toBe(false);
    expect(toolParameters(requestA ?? { messages: [] }, "bb_lookup")).toMatchObject({
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    const callA = callsFor(live.toolCalls, "thread-catalog-a")[0];
    expect(callA.params).toMatchObject({
      providerThreadId: rootA,
      threadId: "thread-catalog-a",
      tool: "bb_lookup",
      arguments: { id: "alpha" },
    });
    answerToolCall(live, callA, { success: true, contentItems: [{ type: "inputText", text: "found alpha" }] });
    await waitUntil(
      () => model.requests.some((request) => toolMessages(request).join("\n").includes("found alpha")),
      "catalog a continuation",
    );

    await startTurn("thread-catalog-b", rootB, "catalog b lookup");
    await waitUntil(() => callsFor(collectToolCalls(live), "thread-catalog-b").length === 1, "catalog b call");
    const requestB = model.requests.find((request) => JSON.stringify(request.messages).includes("catalog b lookup"));
    expect(toolParameters(requestB ?? { messages: [] }, "bb_lookup")).toMatchObject({
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query", "limit"],
    });
    const callB = callsFor(live.toolCalls, "thread-catalog-b")[0];
    expect(callB.params).toMatchObject({
      providerThreadId: rootB,
      threadId: "thread-catalog-b",
      tool: "bb_lookup",
      arguments: { query: "beta", limit: 2 },
    });
    expect(callA.params.providerThreadId).not.toBe(callB.params.providerThreadId);
    process.stderr.write(
      `\nLIVE catalogs: ${JSON.stringify({
        a: toolParameters(requestA ?? { messages: [] }, "bb_lookup"),
        b: toolParameters(requestB ?? { messages: [] }, "bb_lookup"),
      })}\n`,
    );
  }, 180_000);

  it("denies bb tools to an unrelated native session in the same directory", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "text", text: "bound idle" },
      { kind: "tool", name: "bb_echo", args: { text: "nope" } },
      { kind: "tool", name: "bbt_b1_0", args: { text: "nope" } },
      { kind: "text", text: "unrelated done" },
    );
    const root = await startThread("thread-unrelated-root");
    await startTurn("thread-unrelated-root", root, "bound turn");
    await waitUntil(() => model.requests.length >= 1, "bound model request");
    await waitUntil(
      () => deltaKinds(live, "thread-unrelated-root").some((delta) => delta.kind === "turn.boundary"),
      "bound turn boundary",
    );
    const created = payloadOf(
      await engineFetch(engine, "/api/session", {
        method: "POST",
        body: JSON.stringify({
          title: "unrelated",
          location: { directory: engine.workspace },
          model: { providerID: "mock", id: "scripted" },
        }),
      }),
    );
    const sessionID = String(created.id);
    await promptNative(engine, sessionID, "unrelated call bb_echo");
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("unrelated call bb_echo")),
      "unrelated model request",
    );
    const request = model.requests.find((item) => JSON.stringify(item.messages).includes("unrelated call bb_echo"));
    expect(toolNames(request ?? { messages: [] }).some((name) => name === "bb_echo" || name.startsWith("bbt_"))).toBe(
      false,
    );
    await waitUntil(
      () => model.requests.filter((item) => JSON.stringify(item.messages).includes("unrelated")).length >= 3,
      "unrelated forced calls to finish",
    );
    const seen = model.requests
      .filter((item) => JSON.stringify(item.messages).includes("unrelated"))
      .flatMap((item) => toolMessages(item));
    process.stderr.write(`\nLIVE unrelated tools: ${JSON.stringify(toolNames(request ?? { messages: [] }))}\n`);
    const failures = seen.join("\n");
    process.stderr.write(`\nLIVE unrelated failures: ${failures}\n`);
    expect(collectToolCalls(live)).toHaveLength(0);
    expect(failures.replaceAll('\\"', '"')).toContain('No tool named "bb_echo" is currently available');
    expect(failures).toContain("Tool is not available for this request: bbt_b1_0");
  }, 180_000);

  it("rejects a bb call from an imported session whose parentID is the bound root", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "text", text: "bound idle" },
      { kind: "tool", name: "bb_echo", args: { text: "imported" } },
      { kind: "text", text: "import done" },
    );
    const root = await startThread("thread-import-root");
    await startTurn("thread-import-root", root, "bound before transfer");
    await waitUntil(
      () => deltaKinds(live, "thread-import-root").some((delta) => delta.kind === "turn.boundary"),
      "import root boundary",
    );
    const exported = payloadOf(await engineFetch(engine, `/api/experimental/session/${root}/export`));
    const info = isRecord(exported.info) ? exported.info : payloadOf(await engineFetch(engine, `/api/session/${root}`));
    const importedID = `ses_import_${Date.now().toString(36)}`;
    const imported = payloadOf(
      await engineFetch(engine, "/api/experimental/session/im" + "port", {
        method: "POST",
        body: JSON.stringify({
          info: { ...info, id: importedID, parentID: root, title: "imported child" },
          messages: [],
          location: { directory: engine.workspace },
        }),
      }),
    );
    expect(imported.parentID).toBe(root);
    await promptNative(engine, importedID, "imported child calls bb_echo");
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("imported child calls")),
      "imported model request",
    );
    const request = model.requests.find((item) => JSON.stringify(item.messages).includes("imported child calls"));
    const names = toolNames(request ?? { messages: [] });
    process.stderr.write(`\nLIVE imported tools: ${JSON.stringify(names)} parentID=${String(imported.parentID)}\n`);
    expect(names.some((name) => name === "bb_echo" || name.startsWith("bbt_"))).toBe(false);
    await waitUntil(
      () => toolMessages(model.requests.at(-1) ?? { messages: [] }).length > 0 || model.requests.length >= 4,
      "imported call to settle",
    );
    expect(collectToolCalls(live)).toHaveLength(0);
  }, 180_000);

  it("authorizes a native subagent child from verified progress and dispatches as the root", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    model.script.push(
      {
        kind: "tool",
        name: "subagent",
        args: {
          agent: "general",
          description: "Echo via bb",
          prompt: "Call bb_echo with text child-hello, then stop.",
        },
      },
      { kind: "tool", name: "bb_echo", args: { text: "child-hello" } },
      { kind: "text", text: "child done" },
      { kind: "text", text: "parent done" },
    );
    const root = await startThread("thread-child");
    await startTurn("thread-child", root, "spawn a subagent");
    await waitUntil(() => callsFor(collectToolCalls(live), "thread-child").length === 1, "child bb call");
    const call = callsFor(live.toolCalls, "thread-child")[0];
    const progress = subscription.events.find(
      (event) => event.type === "session.tool.progress" && JSON.stringify(event.data).includes("running"),
    );
    process.stderr.write(`\nLIVE child dispatch: ${JSON.stringify(call.params)}\n`);
    process.stderr.write(`\nLIVE subagent progress: ${JSON.stringify(progress?.data)}\n`);
    expect(call.params).toMatchObject({
      providerThreadId: root,
      threadId: "thread-child",
      tool: "bb_echo",
      arguments: { text: "child-hello" },
      providerNativeIds: true,
    });
    const opened = deltaKinds(live, "thread-child").find(
      (delta) => delta.kind === "turn.open" && delta.parentRef === undefined && typeof delta.providerTurnId === "string",
    );
    expect(call.params.turnId).toBe(opened?.providerTurnId);
    expect(call.params.nativeSessionID).toBeUndefined();
    expect(call.params.nativeMessageID).toBeUndefined();
    expect(call.params.callId).toEqual(expect.any(String));
    const childRequest = model.requests.find((request) =>
      JSON.stringify(request.messages).includes("Call bb_echo with text child-hello"),
    );
    expect(toolNames(childRequest ?? { messages: [] })).toContain("bb_echo");
    expect(toolNames(childRequest ?? { messages: [] }).some((name) => name.startsWith("bbt_"))).toBe(false);
    answerToolCall(live, call, { success: true, contentItems: [{ type: "inputText", text: "echo: child-hello" }] });
    await waitUntil(
      () => deltaKinds(live, "thread-child").some((delta) => delta.kind === "turn.boundary"),
      "child owning turn boundary",
    );
    await subscription.stop();
    expect(JSON.stringify(progress?.data)).toContain("sessionID");
  }, 180_000);

  it("rejects a background subagent bb call after the owning turn ends", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    let launched = false;
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("CALL_BB_AFTER_TURN")) return { kind: "tool", name: "bb_echo", args: { text: "late" } };
      if (blob.includes("You are a subagent")) return { kind: "text", text: "child waiting" };
      if (!launched && blob.includes("launch background")) {
        launched = true;
        return {
          kind: "tool",
          name: "subagent",
          args: {
            agent: "general",
            description: "Background echo",
            prompt: "Say hello and stop.",
            background: true,
          },
        };
      }
      return { kind: "text", text: "parent done" };
    };
    const root = await startThread("thread-background");
    await startTurn("thread-background", root, "launch background");
    await waitUntil(
      () =>
        deltaKinds(live, "thread-background").some(
          (delta) =>
            delta.kind === "turn.boundary" &&
            typeof delta.providerTurnId === "string" &&
            delta.providerTurnId.includes(root),
        ),
      "background owning turn boundary",
    );
    const progress = subscription.events.find((event) => event.type === "session.tool.progress");
    const progressMeta = isRecord(progress?.data) && isRecord(progress.data.metadata) ? progress.data.metadata : {};
    const sessionID = typeof progressMeta.sessionID === "string" ? progressMeta.sessionID : "";
    expect(sessionID.startsWith("ses_")).toBe(true);
    await waitForSessionIdle(engine, sessionID);
    const before = collectToolCalls(live).length;
    await promptNative(engine, sessionID, "CALL_BB_AFTER_TURN");
    await waitUntil(() => {
      const late = model.requests.filter((request) => JSON.stringify(request.messages).includes("CALL_BB_AFTER_TURN"));
      return late.flatMap((request) => toolMessages(request)).length > 0 || collectToolCalls(live).length > before;
    }, "background late call");
    await subscription.stop();
    const late = model.requests.filter((request) => JSON.stringify(request.messages).includes("CALL_BB_AFTER_TURN"));
    const failure = late.flatMap((request) => toolMessages(request)).join("\n");
    process.stderr.write(`\nLIVE background rejection: ${failure}\n`);
    expect(failure).toContain(TURN_ENDED);
    expect(collectToolCalls(live)).toHaveLength(before);
  }, 180_000);

  it("rejects an old child call after a new root turn opens", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    let launched = false;
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("CALL_BB_AFTER_NEW_TURN")) return { kind: "tool", name: "bb_echo", args: { text: "late" } };
      if (blob.includes("You are a subagent")) return { kind: "text", text: "child waiting" };
      if (!launched && blob.includes("launch then replace")) {
        launched = true;
        return {
          kind: "tool",
          name: "subagent",
          args: {
            agent: "general",
            description: "Background echo",
            prompt: "Say hello and stop.",
            background: true,
          },
        };
      }
      return { kind: "text", text: "parent done" };
    };
    const root = await startThread("thread-stale-child");
    await startTurn("thread-stale-child", root, "launch then replace");
    await waitUntil(
      () =>
        deltaKinds(live, "thread-stale-child").some(
          (delta) =>
            delta.kind === "turn.boundary" &&
            typeof delta.providerTurnId === "string" &&
            delta.providerTurnId.includes(root),
        ),
      "first owning turn boundary",
    );
    const progress = subscription.events.find((event) => event.type === "session.tool.progress");
    const progressMeta = isRecord(progress?.data) && isRecord(progress.data.metadata) ? progress.data.metadata : {};
    const sessionID = typeof progressMeta.sessionID === "string" ? progressMeta.sessionID : "";
    expect(sessionID.startsWith("ses_")).toBe(true);
    await startTurn("thread-stale-child", root, "second root turn");
    await waitUntil(
      () =>
        deltaKinds(live, "thread-stale-child").filter(
          (delta) =>
            delta.kind === "turn.boundary" &&
            typeof delta.providerTurnId === "string" &&
            delta.providerTurnId.includes(root),
        ).length >= 2,
      "second owning turn boundary",
    );
    const before = collectToolCalls(live).length;
    await promptNative(engine, sessionID, "CALL_BB_AFTER_NEW_TURN");
    await waitUntil(() => {
      const late = model.requests.filter((request) => JSON.stringify(request.messages).includes("CALL_BB_AFTER_NEW_TURN"));
      return late.flatMap((request) => toolMessages(request)).join("\n").includes(TURN_ENDED);
    }, "stale child rejection");
    await subscription.stop();
    const failure = model.requests
      .filter((request) => JSON.stringify(request.messages).includes("CALL_BB_AFTER_NEW_TURN"))
      .flatMap((request) => toolMessages(request))
      .join("\n");
    process.stderr.write(`\nLIVE stale child rejection: ${failure}\n`);
    expect(failure).toContain(TURN_ENDED);
    expect(collectToolCalls(live)).toHaveLength(before);
  }, 180_000);

  it("dispatches a tool call that is the first model response", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "immediate" } },
      { kind: "text", text: "fast done" },
    );
    const root = await startThread("thread-fast");
    await startTurn("thread-fast", root, "call echo immediately");
    await waitUntil(() => collectToolCalls(live).length === 1, "fast first call");
    const call = live.toolCalls[0];
    if (call === undefined) throw new Error("missing fast call");
    const opened = deltaKinds(live, "thread-fast").find(
      (delta) => delta.kind === "turn.open" && delta.parentRef === undefined && typeof delta.providerTurnId === "string",
    );
    expect(call.params.turnId).toBe(opened?.providerTurnId);
    expect(String(call.params.turnId)).toContain(root);
    answerToolCall(live, call, { success: true, contentItems: [{ type: "inputText", text: "echo: immediate" }] });
    await waitUntil(() => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: immediate"), "fast call delivered");
    expect(toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n")).not.toContain(TURN_ENDED);
    expect(collectToolCalls(live)).toHaveLength(1);
  }, 180_000);

  it("fails closed when lost step events have no durable message-to-execution link", async () => {
    const { model, live, startThread, startTurn } = ctx;
    live.setIgnoredNativeEvents(IDENTITY_EVENTS);
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "from-log" } },
      { kind: "text", text: "gap done" },
    );
    const root = await startThread("thread-gap");
    await startTurn("thread-gap", root, "call echo immediately");
    await live.injectResync("thread-gap");
    await waitUntil(() => {
      const dispatched = collectToolCalls(live).some((call) => String(call.params.turnId).includes(root));
      const rejected = model.requests.some((request) => toolMessages(request).join("\n").includes(ORIGIN_UNKNOWN));
      return dispatched || rejected;
    }, "durable link or fail-closed rejection");
    if (collectToolCalls(live).length > 0) {
      const call = live.toolCalls[0];
      if (call === undefined) throw new Error("missing rebuilt call");
      answerToolCall(live, call, { success: true, contentItems: [{ type: "inputText", text: "echo: from-log" }] });
      await waitUntil(
        () => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: from-log"),
        "rebuilt call delivered",
      );
      expect(toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n")).not.toContain(ORIGIN_UNKNOWN);
      return;
    }
    const failure = model.requests.flatMap((request) => toolMessages(request)).join("\n");
    expect(failure).toContain(ORIGIN_UNKNOWN);
    expect(collectToolCalls(live)).toHaveLength(0);
  }, 180_000);

  it("rejects an old child call after the origin map is lost and rebuilt", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    let launched = false;
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("CALL_BB_AFTER_LOST_MAP")) return { kind: "tool", name: "bb_echo", args: { text: "late" } };
      if (blob.includes("You are a subagent")) return { kind: "text", text: "child waiting" };
      if (!launched && blob.includes("launch then forget")) {
        launched = true;
        return {
          kind: "tool",
          name: "subagent",
          args: {
            agent: "general",
            description: "Background echo",
            prompt: "Say hello and stop.",
            background: true,
          },
        };
      }
      return { kind: "text", text: "parent done" };
    };
    const root = await startThread("thread-lost-map");
    await startTurn("thread-lost-map", root, "launch then forget");
    await waitUntil(
      () =>
        deltaKinds(live, "thread-lost-map").some(
          (delta) =>
            delta.kind === "turn.boundary" &&
            typeof delta.providerTurnId === "string" &&
            delta.providerTurnId.includes(root),
        ),
      "first turn boundary before the map is dropped",
    );
    const progress = subscription.events.find((event) => event.type === "session.tool.progress");
    const progressMeta = isRecord(progress?.data) && isRecord(progress.data.metadata) ? progress.data.metadata : {};
    const sessionID = typeof progressMeta.sessionID === "string" ? progressMeta.sessionID : "";
    expect(sessionID.startsWith("ses_")).toBe(true);
    live.forgetOriginMap("thread-lost-map");
    await live.injectResync("thread-lost-map");
    await startTurn("thread-lost-map", root, "second root turn");
    await waitUntil(
      () =>
        deltaKinds(live, "thread-lost-map").filter(
          (delta) =>
            delta.kind === "turn.boundary" &&
            typeof delta.providerTurnId === "string" &&
            delta.providerTurnId.includes(root),
        ).length >= 2,
      "second turn boundary after rebuild",
    );
    const before = collectToolCalls(live).length;
    await promptNative(engine, sessionID, "CALL_BB_AFTER_LOST_MAP");
    await waitUntil(() => {
      const late = model.requests.filter((request) => JSON.stringify(request.messages).includes("CALL_BB_AFTER_LOST_MAP"));
      const failure = late.flatMap((request) => toolMessages(request)).join("\n");
      return failure.includes(TURN_ENDED) || failure.includes(ORIGIN_UNKNOWN);
    }, "lost-map child rejection");
    await subscription.stop();
    expect(collectToolCalls(live)).toHaveLength(before);
  }, 180_000);

  it("does not authorize an imported session resumed through subagent", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    let importedID = "";
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("CALL_BB_FROM_IMPORTED")) return { kind: "tool", name: "bb_echo", args: { text: "stolen" } };
      if (importedID.length > 0 && blob.includes("resume imported")) {
        return {
          kind: "tool",
          name: "subagent",
          args: {
            agent: "general",
            description: "Resume imported",
            prompt: "CALL_BB_FROM_IMPORTED",
            sessionID: importedID,
          },
        };
      }
      return { kind: "text", text: "setup done" };
    };
    const root = await startThread("thread-launder");
    await startTurn("thread-launder", root, "setup before resume");
    await waitUntil(
      () => deltaKinds(live, "thread-launder").some((delta) => delta.kind === "turn.boundary"),
      "launder setup boundary",
    );
    const exported = payloadOf(await engineFetch(engine, `/api/experimental/session/${root}/export`));
    const info = isRecord(exported.info) ? exported.info : payloadOf(await engineFetch(engine, `/api/session/${root}`));
    importedID = `ses_resume_${Date.now().toString(36)}`;
    await engineFetch(engine, "/api/experimental/session/im" + "port", {
      method: "POST",
      body: JSON.stringify({
        info: { ...info, id: importedID, parentID: root, title: "resumed imported" },
        messages: [],
        location: { directory: engine.workspace },
      }),
    });
    await startTurn("thread-launder", root, "resume imported");
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("CALL_BB_FROM_IMPORTED")),
      "resumed imported model request",
    );
    const request = model.requests.find((item) => JSON.stringify(item.messages).includes("CALL_BB_FROM_IMPORTED"));
    expect(toolNames(request ?? { messages: [] }).some((name) => name === "bb_echo" || name.startsWith("bbt_"))).toBe(
      false,
    );
    await waitUntil(() => {
      const late = model.requests.filter((item) => JSON.stringify(item.messages).includes("CALL_BB_FROM_IMPORTED"));
      return late.flatMap((item) => toolMessages(item)).length > 0;
    }, "resumed imported call to settle");
    const failure = model.requests
      .filter((item) => JSON.stringify(item.messages).includes("CALL_BB_FROM_IMPORTED"))
      .flatMap((item) => toolMessages(item))
      .join("\n");
    process.stderr.write(`\nLIVE resumed imported: ${failure}\n`);
    expect(failure.replaceAll('\\"', '"')).toContain('No tool named "bb_echo" is currently available');
    expect(collectToolCalls(live)).toHaveLength(0);
  }, 180_000);

  it("denies a descendant call after the root disallowedTools list changes", async () => {
    const { model, engine, live, startThread, startTurn, steerTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    let launched = false;
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("CHILD_DENIED_ECHO")) return { kind: "tool", name: "bb_echo", args: { text: "late" } };
      if (blob.includes("You are a subagent")) return { kind: "text", text: "child ready" };
      if (!launched && blob.includes("spawn for deny")) {
        launched = true;
        return {
          kind: "tool",
          name: "subagent",
          args: {
            agent: "general",
            description: "Hold",
            prompt: "Say ready.",
            background: true,
          },
        };
      }
      return { kind: "tool", name: "bb_echo", args: { text: "hold-parent" } };
    };
    const root = await startThread("thread-deny-later");
    await startTurn("thread-deny-later", root, "spawn for deny");
    await waitUntil(
      () => collectToolCalls(live).some((call) => call.params.arguments !== undefined && JSON.stringify(call.params.arguments).includes("hold-parent")),
      "parent hold call",
    );
    const progress = subscription.events.find((event) => event.type === "session.tool.progress");
    const progressMeta = isRecord(progress?.data) && isRecord(progress.data.metadata) ? progress.data.metadata : {};
    const sessionID = typeof progressMeta.sessionID === "string" ? progressMeta.sessionID : "";
    expect(sessionID.startsWith("ses_")).toBe(true);
    const opened = deltaKinds(live, "thread-deny-later").find(
      (delta) => delta.kind === "turn.open" && delta.parentRef === undefined && typeof delta.providerTurnId === "string",
    );
    expect(typeof opened?.providerTurnId).toBe("string");
    await steerTurn("thread-deny-later", root, String(opened?.providerTurnId), "policy update", ["bb_echo"]);
    const before = collectToolCalls(live).length;
    await promptNative(engine, sessionID, "CHILD_DENIED_ECHO");
    await waitUntil(() => {
      const late = model.requests.filter((request) => JSON.stringify(request.messages).includes("CHILD_DENIED_ECHO"));
      return late.flatMap((request) => toolMessages(request)).length > 0;
    }, "denied descendant call");
    await subscription.stop();
    const failure = model.requests
      .filter((request) => JSON.stringify(request.messages).includes("CHILD_DENIED_ECHO"))
      .flatMap((request) => toolMessages(request))
      .join("\n");
    process.stderr.write(`\nLIVE descendant deny: ${failure}\n`);
    expect(failure).toContain("bb_echo is denied for this bb thread");
    expect(collectToolCalls(live)).toHaveLength(before);
  }, 180_000);

  it("runs a native fork native-only and gives a bb fork its own binding", async () => {
    const { model, engine, live, startThread, startTurn, forkThread } = ctx;
    const forkedTool = {
      name: "bb_forked",
      description: "Fork-only echo.",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
    };
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("bb fork turn") && !blob.includes("fresh")) {
        return { kind: "tool", name: "bb_forked", args: { note: "fresh" } };
      }
      if (blob.includes("native fork turn")) return { kind: "text", text: "native fork done" };
      return { kind: "text", text: "source done" };
    };
    const root = await startThread("thread-fork-source");
    await startTurn("thread-fork-source", root, "source turn before fork");
    await waitUntil(
      () => deltaKinds(live, "thread-fork-source").some((delta) => delta.kind === "turn.boundary"),
      "fork source boundary",
    );
    const native = payloadOf(
      await engineFetch(engine, `/api/session/${root}/fork`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(native.parentID).toBeUndefined();
    expect(payloadOf(native).metadata ?? native.metadata).toMatchObject({ bbThreadId: "thread-fork-source" });
    const nativeID = String(native.id);
    await promptNative(engine, nativeID, "native fork turn");
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("native fork turn")),
      "native fork model request",
    );
    const nativeRequest = model.requests.find((request) => JSON.stringify(request.messages).includes("native fork turn"));
    expect(toolNames(nativeRequest ?? { messages: [] }).some((name) => name === "bb_echo" || name.startsWith("bbt_"))).toBe(
      false,
    );
    await waitUntil(async () => {
      const listed = await engineFetch(engine, `/api/session/${nativeID}/message`);
      return JSON.stringify(listed).includes("native fork done");
    }, "native fork completion");

    const forked = await forkThread("thread-fork-bb", root, { dynamicTools: [forkedTool] });
    const stamped = payloadOf(await engineFetch(engine, `/api/session/${forked}`));
    process.stderr.write(`\nLIVE bb fork metadata: ${JSON.stringify(stamped.metadata)}\n`);
    expect(stamped.metadata).toMatchObject({ bbThreadId: "thread-fork-bb" });
    await startTurn("thread-fork-bb", forked, "bb fork turn");
    await waitUntil(() => callsFor(collectToolCalls(live), "thread-fork-bb").length === 1, "bb fork call");
    const request = model.requests.find((item) => JSON.stringify(item.messages).includes("bb fork turn"));
    expect(toolNames(request ?? { messages: [] })).toContain("bb_forked");
    expect(toolNames(request ?? { messages: [] })).not.toContain("bb_echo");
    expect(callsFor(live.toolCalls, "thread-fork-bb")[0].params).toMatchObject({
      providerThreadId: forked,
      threadId: "thread-fork-bb",
      tool: "bb_forked",
      arguments: { note: "fresh" },
    });
  }, 180_000);

  it("hides a canonically denied bb tool and still advertises bb tools to the plan agent", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "denied" } },
      { kind: "text", text: "deny done" },
      { kind: "text", text: "plan done" },
    );
    const denied = await startThread("thread-deny", { disallowedTools: ["bb_echo"] });
    await startTurn("thread-deny", denied, "try denied echo");
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("try denied echo")),
      "denied model request",
    );
    const deniedRequest = model.requests.find((request) => JSON.stringify(request.messages).includes("try denied echo"));
    const deniedNames = toolNames(deniedRequest ?? { messages: [] });
    process.stderr.write(`\nLIVE denied tools: ${JSON.stringify(deniedNames)}\n`);
    expect(deniedNames).not.toContain("bb_echo");
    expect(deniedNames.some((name) => name.startsWith("bbt_"))).toBe(false);
    await waitUntil(
      () => deltaKinds(live, "thread-deny").some((delta) => delta.kind === "turn.boundary"),
      "denied turn boundary",
    );
    expect(collectToolCalls(live)).toHaveLength(0);

    const planned = await startThread("thread-plan");
    await startTurn("thread-plan", planned, "plan mode turn", PLAN_OPTIONS);
    await waitUntil(
      () => model.requests.some((request) => JSON.stringify(request.messages).includes("plan mode turn")),
      "plan model request",
    );
    const planRequest = model.requests.find((request) => JSON.stringify(request.messages).includes("plan mode turn"));
    const planNames = toolNames(planRequest ?? { messages: [] });
    process.stderr.write(`\nLIVE plan tools: ${JSON.stringify(planNames)}\n`);
    expect(planNames).toContain("bb_echo");
    expect(planNames.some((name) => name.startsWith("bbt_"))).toBe(false);
  }, 180_000);

  it("delivers a successful image result into the next model request", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "picture" } }, { kind: "text", text: "seen" });
    const root = await startThread("thread-image");
    await startTurn("thread-image", root, "return an image");
    await waitUntil(() => collectToolCalls(live).length === 1, "image tool call");
    answerToolCall(live, live.toolCalls[0], {
      success: true,
      contentItems: [
        { type: "inputText", text: "caption" },
        { type: "inputImage", imageUrl: PNG },
      ],
    });
    await waitUntil(() => model.requests.length >= 2, "image continuation");
    const next = model.requests.find((request) => toolMessages(request).some((text) => text.includes("caption")));
    expect(next).toBeDefined();
    const messages = next?.messages ?? [];
    const toolIndex = messages.findIndex(
      (message) => message.role === "tool" && String(message.content).includes("caption"),
    );
    const follow = messages[toolIndex + 1];
    process.stderr.write(`\nLIVE image follow: ${JSON.stringify(follow)}\n`);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(follow?.role).toBe("user");
    expect(follow?.content).toEqual([{ type: "image_url", image_url: { url: PNG } }]);
  }, 180_000);

  it("delivers a result over 50 KiB without native truncation", async () => {
    const { model, live, startThread, startTurn } = ctx;
    const body = "x".repeat(120 * 1024);
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "big" } }, { kind: "text", text: "got it" });
    const root = await startThread("thread-large");
    await startTurn("thread-large", root, "return a large result");
    await waitUntil(() => collectToolCalls(live).length === 1, "large tool call");
    answerToolCall(live, live.toolCalls[0], {
      success: true,
      contentItems: [{ type: "inputText", text: body }],
    });
    await waitUntil(() => model.requests.length >= 2, "large continuation");
    const text = toolMessages(model.requests[1]).join("\n");
    process.stderr.write(`\nLIVE large result bytes: ${Buffer.byteLength(text, "utf8")}\n`);
    expect(text).toContain(body);
    expect(text).not.toContain("truncated");
    expect(text).not.toMatch(/saved to /);
  }, 180_000);

  it("strips bb tools from compaction and generate model requests", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    model.respond = (request) => {
      const blob = JSON.stringify(request.messages);
      if (blob.includes("MUST use this format") || blob.includes("summarize the conversation")) {
        return { kind: "text", text: "## Objective\n- auxiliary setup\n" };
      }
      return { kind: "text", text: "ready for auxiliary" };
    };
    const root = await startThread("thread-auxiliary");
    await startTurn("thread-auxiliary", root, "auxiliary setup");
    await waitUntil(
      () => deltaKinds(live, "thread-auxiliary").some((delta) => delta.kind === "turn.boundary"),
      "auxiliary setup boundary",
    );
    const beforeGenerate = model.allRequests.length;
    const generated = await engineFetch(engine, `/api/session/${root}/generate`, {
      method: "POST",
      body: JSON.stringify({ prompt: "generate a private label" }),
    });
    const generateRequests = model.allRequests
      .slice(beforeGenerate)
      .filter((request) => JSON.stringify(request.messages).includes("generate a private label"));
    const beforeCompact = model.allRequests.length;
    await engineFetch(engine, `/api/session/${root}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await waitUntil(async () => {
      if (deltaKinds(live, "thread-auxiliary").some((delta) => delta.kind === "context.compacted")) return true;
      const listed = JSON.stringify(await engineFetch(engine, `/api/session/${root}/message`));
      return listed.includes('"type":"compaction"') && listed.includes('"status":"completed"');
    }, "compaction ended", 90_000);
    await subscription.stop();
    const compactRequests = model.allRequests.slice(beforeCompact);
    const phase = [...generateRequests, ...compactRequests];
    process.stderr.write(
      `\nLIVE auxiliary requests: ${JSON.stringify({
        generated,
        generate: generateRequests.map((request) => toolNames(request)),
        compact: compactRequests.map((request) => toolNames(request)),
      })}\n`,
    );
    expect(generateRequests.length).toBeGreaterThan(0);
    expect(phase.some((request) => toolNames(request).some((name) => name === "bb_echo" || name.startsWith("bbt_")))).toBe(
      false,
    );
    expect(JSON.stringify(phase)).not.toContain("bbt_");
  }, 180_000);
});
