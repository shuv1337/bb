import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";
import {
  answerToolCall,
  collectToolCalls,
  companionDir,
  createLiveContext,
  deltaKinds,
  engineAppId,
  engineBinary,
  engineFetch,
  subscribeEngineEvents,
  toolMessages,
  waitUntil,
  type Engine,
  type EngineEvent,
  type LiveBridge,
} from "./companion-engine.live-harness.js";

const laterPluginDir = join("/tmp/shuvcode", "0b-c-later");
const laterPluginFile = join(laterPluginDir, "server.ts");

function markerSource(pluginId: string, rpcId: string): string {
  return [
    "export default {",
    `  id: ${JSON.stringify(pluginId)},`,
    "  async setup(ctx) {",
    "    const generation = crypto.randomUUID()",
    "    await ctx.rpc.register(",
    "      {",
    `        id: ${JSON.stringify(rpcId)},`,
    '        methods: { hello: { input: { type: "object" }, output: { type: "object" } } },',
    "        events: {},",
    "      },",
    "      { hello: async () => ({ generation }) },",
    "    )",
    "  },",
    "}",
    "",
  ].join("\n");
}

mkdirSync(laterPluginDir, { recursive: true });
writeFileSync(laterPluginFile, markerSource("bb-spike-later", "bb.spike.later"));

function note(message: string): void {
  process.stderr.write(`LIVE ${engineAppId} ${message}\n`);
}

function locationQuery(engine: Engine): string {
  return `location[directory]=${encodeURIComponent(engine.workspace)}`;
}

function outputOf(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && "output" in body) {
    const output = (body as { output?: unknown }).output;
    if (output !== null && typeof output === "object" && !Array.isArray(output)) {
      return output as Record<string, unknown>;
    }
  }
  return {};
}

async function rpcCall(engine: Engine, rpcID: string, method: string, input: unknown = {}): Promise<unknown> {
  return engineFetch(engine, `/api/rpc/${encodeURIComponent(rpcID)}/${method}?${locationQuery(engine)}`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

async function hello(engine: Engine): Promise<{ generation: string; version: number; protocol: string }> {
  const output = outputOf(await rpcCall(engine, "bb.tools.v1", "hello"));
  if (typeof output.generation !== "string" || typeof output.version !== "number") {
    throw new Error(`companion hello missing generation: ${JSON.stringify(output)}`);
  }
  return {
    generation: output.generation,
    version: output.version,
    protocol: typeof output.protocol === "string" ? output.protocol : "",
  };
}

async function markerHello(engine: Engine, rpcId: string): Promise<string | null> {
  try {
    const output = outputOf(await rpcCall(engine, rpcId, "hello"));
    return typeof output.generation === "string" ? output.generation : null;
  } catch {
    return null;
  }
}

async function pluginList(engine: Engine): Promise<unknown> {
  return engineFetch(engine, `/api/plugin?${locationQuery(engine)}`);
}

function summarizePlugins(body: unknown): string {
  const data =
    body !== null && typeof body === "object" && "data" in body ? (body as { data?: unknown }).data : body;
  if (!Array.isArray(data)) return JSON.stringify(body).slice(0, 800);
  return data
    .map((item) => {
      const record = item as {
        id?: string;
        source?: { type?: string; path?: string; target?: string };
        state?: { status?: string; error?: string };
      };
      const source = record.source?.path ?? record.source?.target ?? record.source?.type ?? "?";
      const error = record.state?.error ? ` ${record.state.error}` : "";
      return `${record.id ?? "?"} ${record.state?.status ?? "?"}${error} ${source}`;
    })
    .join(" | ");
}

async function requireMarker(engine: Engine, rpcId: string): Promise<string> {
  let generation = "";
  try {
    await waitUntil(async () => {
      const next = await markerHello(engine, rpcId);
      if (next === null) return false;
      generation = next;
      return true;
    }, `${rpcId} hello`, 20_000);
  } catch (error) {
    note(`plugin list ${summarizePlugins(await pluginList(engine).catch((listError) => String(listError)))}`);
    throw error;
  }
  return generation;
}

function eventTypes(events: readonly EngineEvent[]): string[] {
  return [...new Set(events.map((event) => event.type))];
}

const UNCERTAIN_TOOL_MESSAGE =
  "bb tool outcome is uncertain: the companion generation ended before the result was delivered";

function sessionEvents(events: readonly EngineEvent[], sessionId: string, type: string): EngineEvent[] {
  return events.filter((event) => event.type === type && event.data?.sessionID === sessionId);
}

function callIdOf(params: Record<string, unknown>): string {
  if (typeof params.callId !== "string" || params.callId.length === 0) {
    throw new Error("missing native call id");
  }
  return params.callId;
}

function assertUncertainSettlement(events: readonly EngineEvent[], sessionId: string, callId: string): void {
  const failed = sessionEvents(events, sessionId, "session.tool.failed").filter((event) => event.data?.id === callId);
  expect(failed).toHaveLength(1);
  expect(failed[0]?.data).toMatchObject({
    sessionID: sessionId,
    id: callId,
    executed: false,
    error: { type: "tool.execution", message: UNCERTAIN_TOOL_MESSAGE },
  });
  const execution = sessionEvents(events, sessionId, "session.execution.failed");
  expect(execution.length).toBeGreaterThan(0);
  expect(execution[0]?.data).toMatchObject({
    sessionID: sessionId,
    error: {
      type: "provider.no-route",
      message: `No model is available for session ${sessionId}`,
    },
  });
  expect(sessionEvents(events, sessionId, "session.tool.success").some((event) => event.data?.id === callId)).toBe(false);
}

function withoutReloadTick(text: string): string {
  return text.replace(/\nexport const reloadTick_\d+ = \d+\n/g, "\n");
}

function bump(file: string): () => void {
  const original = withoutReloadTick(readFileSync(file, "utf8"));
  const tick = Date.now();
  writeFileSync(file, `${original}\nexport const reloadTick_${tick} = ${tick}\n`);
  return () => {
    writeFileSync(file, original);
  };
}

function earlyPluginFile(engine: Engine): string {
  return join(engine.root, "config", engineAppId, "plugin", "aaa-early", "server.ts");
}

function configPath(engine: Engine): string {
  return join(engine.root, "config", engineAppId, "opencode.json");
}

async function waitIdle(engine: Engine, sessionId: string): Promise<void> {
  let last = "";
  await waitUntil(async () => {
    const info = (await engineFetch(engine, `/api/session/${sessionId}`)) as { status?: { type?: string } };
    last = info.status?.type ?? JSON.stringify(info).slice(0, 200);
    return info.status?.type !== "busy";
  }, `session idle (last status ${last})`).catch(async (error: unknown) => {
    throw new Error(`${String(error)}; last status ${last}`);
  });
}

async function rawTurn(
  live: LiveBridge,
  id: number,
  threadId: string,
  providerThreadId: string,
  text: string,
): Promise<{ error?: { message?: string } }> {
  live.rpc.sendRequest(id, "turn/start", {
    threadId,
    providerThreadId,
    input: [{ type: "text", text, mentions: [] }],
    clientRequestId: "creq_23456789ab",
    options: FULL_PERMISSION_OPTIONS,
  });
  return live.rpc.waitForResponse(id);
}

const ctx = createLiveContext({
  plugins: (dir) => [dir, laterPluginDir],
  prepare: ({ root }) => {
    const dir = join(root, "config", engineAppId, "plugin", "aaa-early");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.ts"), markerSource("bb-spike-early", "bb.spike.early"));
  },
});

describe.skipIf(engineBinary === undefined)("OpenCode companion reload lifecycle", () => {
  it("keeps one hello generation per activation and does not reattach a held binding", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const first = await hello(engine);
    const second = await hello(engine);
    note(`hello generation ${first.generation} version ${first.version} protocol ${first.protocol}`);
    note(`plugins ${summarizePlugins(await pluginList(engine))}`);
    expect(first.protocol).toBe("bb.tools.v1");
    expect(first.version).toBe(1);
    expect(first.generation).toBe(second.generation);
    expect(first.generation.length).toBeGreaterThan(8);
    expect(await requireMarker(engine, "bb.spike.early")).not.toBe("");
    expect(await requireMarker(engine, "bb.spike.later")).not.toBe("");

    model.script.push({ kind: "text", text: "one" }, { kind: "text", text: "two" });
    const providerThreadId = await startThread("thread-generation");
    await startTurn("thread-generation", providerThreadId, "first turn");
    await waitUntil(() => model.requests.length >= 1, "first turn");
    await waitIdle(engine, providerThreadId);
    await startTurn("thread-generation", providerThreadId, "second turn");
    await waitUntil(() => model.requests.length >= 2, "second turn");
    expect(live.warnings.some((message) => message.includes("reattached bb tools"))).toBe(false);
    expect((await hello(engine)).generation).toBe(first.generation);
    expect(model.requests[0]?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
    expect(model.requests[1]?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
  }, 180_000);

  it("settles a claimed call as uncertain when the companion entrypoint reloads", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;
    const before = await hello(engine);
    const beforeEarly = await requireMarker(engine, "bb.spike.early");
    const beforeLater = await requireMarker(engine, "bb.spike.later");
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "hold" } },
      { kind: "tool", name: "bb_echo", args: { text: "again" } },
      { kind: "text", text: "done" },
    );
    const providerThreadId = await startThread("thread-companion-reload");
    await startTurn("thread-companion-reload", providerThreadId, "call echo and hold");
    await waitUntil(() => collectToolCalls(live).length === 1, "claimed call");
    const restore = bump(join(companionDir, "server.ts"));
    try {
      const started = Date.now();
      await waitUntil(async () => {
        const next = await hello(engine).catch(() => null);
        return next !== null && next.generation !== before.generation;
      }, "companion generation change", 45_000);
      const pickupMs = Date.now() - started;
      const after = await hello(engine);
      const afterEarly = await markerHello(engine, "bb.spike.early");
      const afterLater = await markerHello(engine, "bb.spike.later");
      note(
        `companion touch pickup ${pickupMs}ms generation ${before.generation} -> ${after.generation} early ${beforeEarly} -> ${afterEarly} later ${beforeLater} -> ${afterLater} events ${eventTypes(events).join(",")}`,
      );
      expect(after.generation).not.toBe(before.generation);
      expect(afterEarly).toBe(beforeEarly);
      expect(afterLater).not.toBe(beforeLater);

      await waitUntil(
        () =>
          sessionEvents(events, providerThreadId, "session.tool.failed").length > 0 &&
          sessionEvents(events, providerThreadId, "session.execution.failed").length > 0,
        "uncertain settlement",
      );
      assertUncertainSettlement(events, providerThreadId, callIdOf(live.toolCalls[0]!.params));
      note(`companion reload tool failure ${JSON.stringify(sessionEvents(events, providerThreadId, "session.tool.failed")[0]?.data)}`);
      note(`companion reload execution ${JSON.stringify(sessionEvents(events, providerThreadId, "session.execution.failed")[0]?.data)}`);
      expect(collectToolCalls(live)).toHaveLength(1);

      answerToolCall(live, live.toolCalls[0]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: hold" }],
      });
      await waitUntil(
        () =>
          live.warnings.some(
            (message) =>
              message.includes("could not deliver bb tool result") && message.includes("not retrying"),
          ),
        "late result warning",
      );
      expect(collectToolCalls(live)).toHaveLength(1);
      expect(model.requests.filter((request) => toolMessages(request).join("\n").includes("echo: hold"))).toHaveLength(0);
      await waitIdle(engine, providerThreadId);
      const warningAt = live.warnings.length;
      await startTurn("thread-companion-reload", providerThreadId, "call echo again");
      const reattach = live.warnings.slice(warningAt).find((message) => message.includes("reattached bb tools"));
      note(`companion reload reattach ${reattach ?? "missing"}`);
      expect(reattach).toContain(before.generation);
      expect(reattach).toContain(after.generation);
      await waitUntil(() => collectToolCalls(live).length === 2, "reattached call");
      expect(model.requests.at(-1)?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
      expect(live.toolCalls[1]?.params.callId).not.toBe(live.toolCalls[0]?.params.callId);
      answerToolCall(live, live.toolCalls[1]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: again" }],
      });
      await waitUntil(
        () => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: again"),
        "round trip after reattach",
      );
    } finally {
      restore();
      await subscription.stop();
    }
  }, 180_000);

  it("settles a claimed call as uncertain when an earlier plugin changes", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;
    const before = await hello(engine);
    const beforeEarly = await requireMarker(engine, "bb.spike.early");
    const beforeLater = await requireMarker(engine, "bb.spike.later");
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "hold" } },
      { kind: "tool", name: "bb_echo", args: { text: "again" } },
      { kind: "text", text: "done" },
    );
    const providerThreadId = await startThread("thread-early-reload");
    await startTurn("thread-early-reload", providerThreadId, "call echo and hold");
    await waitUntil(() => collectToolCalls(live).length === 1, "claimed call");
    const restore = bump(earlyPluginFile(engine));
    try {
      const started = Date.now();
      await waitUntil(async () => {
        const next = await hello(engine).catch(() => null);
        return next !== null && next.generation !== before.generation;
      }, "generation change after earlier plugin", 45_000);
      const pickupMs = Date.now() - started;
      const after = await hello(engine);
      const afterEarly = await markerHello(engine, "bb.spike.early");
      const afterLater = await markerHello(engine, "bb.spike.later");
      note(
        `earlier plugin bump pickup ${pickupMs}ms generation ${before.generation} -> ${after.generation} early ${beforeEarly} -> ${afterEarly} later ${beforeLater} -> ${afterLater} events ${eventTypes(events).join(",")}`,
      );
      expect(after.generation).not.toBe(before.generation);
      expect(afterEarly).not.toBe(beforeEarly);
      expect(afterLater).not.toBe(beforeLater);
      await waitUntil(
        () =>
          sessionEvents(events, providerThreadId, "session.tool.failed").length > 0 &&
          sessionEvents(events, providerThreadId, "session.execution.failed").length > 0,
        "uncertain settlement",
      );
      assertUncertainSettlement(events, providerThreadId, callIdOf(live.toolCalls[0]!.params));
      note(`earlier plugin tool failure ${JSON.stringify(sessionEvents(events, providerThreadId, "session.tool.failed")[0]?.data)}`);
      note(`earlier plugin execution ${JSON.stringify(sessionEvents(events, providerThreadId, "session.execution.failed")[0]?.data)}`);
      answerToolCall(live, live.toolCalls[0]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: hold" }],
      });
      await waitUntil(
        () => live.warnings.some((message) => message.includes("not retrying")),
        "late result warning",
      );
      expect(collectToolCalls(live)).toHaveLength(1);
      await waitIdle(engine, providerThreadId);
      const warningAt = live.warnings.length;
      await startTurn("thread-early-reload", providerThreadId, "call echo again");
      expect(live.warnings.slice(warningAt).some((message) => message.includes("reattached bb tools"))).toBe(true);
      await waitUntil(() => collectToolCalls(live).length === 2, "reattached call");
      expect(model.requests.at(-1)?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
      answerToolCall(live, live.toolCalls[1]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: again" }],
      });
      await waitUntil(() => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: again"), "round trip after earlier plugin reload");
    } finally {
      restore();
      await subscription.stop();
    }
  }, 180_000);

  it("leaves the companion binding intact when a later plugin changes", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;
    const before = await hello(engine);
    const beforeLater = await requireMarker(engine, "bb.spike.later");
    const beforeEarly = await requireMarker(engine, "bb.spike.early");
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "hold" } },
      { kind: "text", text: "delivered" },
    );
    const providerThreadId = await startThread("thread-later-reload");
    await startTurn("thread-later-reload", providerThreadId, "call echo and hold");
    await waitUntil(() => collectToolCalls(live).length === 1, "claimed call");
    const restore = bump(laterPluginFile);
    try {
      const started = Date.now();
      await waitUntil(async () => (await markerHello(engine, "bb.spike.later")) !== beforeLater, "later plugin generation change", 45_000);
      const pickupMs = Date.now() - started;
      const after = await hello(engine);
      const afterEarly = await markerHello(engine, "bb.spike.early");
      const afterLater = await markerHello(engine, "bb.spike.later");
      note(
        `later plugin bump pickup ${pickupMs}ms companion ${before.generation} -> ${after.generation} early ${beforeEarly} -> ${afterEarly} later ${beforeLater} -> ${afterLater} events ${eventTypes(events).join(",")}`,
      );
      expect(after.generation).toBe(before.generation);
      expect(afterEarly).toBe(beforeEarly);
      expect(afterLater).not.toBe(beforeLater);
      const heldCallId = callIdOf(live.toolCalls[0]!.params);
      answerToolCall(live, live.toolCalls[0]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: hold" }],
      });
      await waitUntil(
        () =>
          toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: hold") &&
          sessionEvents(events, providerThreadId, "session.tool.success").some((event) => event.data?.id === heldCallId),
        "result delivered on intact binding",
      );
      expect(sessionEvents(events, providerThreadId, "session.tool.success").find((event) => event.data?.id === heldCallId)?.data).toMatchObject({
        sessionID: providerThreadId,
        id: heldCallId,
      });
      expect(model.requests.at(-1)?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
      expect(sessionEvents(events, providerThreadId, "session.tool.failed")).toHaveLength(0);
      expect(live.warnings.some((message) => message.includes("not retrying") || message.includes("reattached bb tools"))).toBe(false);
    } finally {
      restore();
      await subscription.stop();
    }
  }, 180_000);

  it("reattaches after a location reload between turns", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;
    const before = await hello(engine);
    const beforeEarly = await requireMarker(engine, "bb.spike.early");
    const beforeLater = await requireMarker(engine, "bb.spike.later");
    model.script.push(
      { kind: "text", text: "first" },
      { kind: "tool", name: "bb_echo", args: { text: "after" } },
      { kind: "text", text: "done" },
    );
    const providerThreadId = await startThread("thread-location-reload");
    await startTurn("thread-location-reload", providerThreadId, "first turn");
    await waitUntil(() => model.requests.length >= 1, "first turn");
    await waitIdle(engine, providerThreadId);
    const started = Date.now();
    await engineFetch(engine, "/api/location/reload", { method: "POST" });
    await waitUntil(async () => {
      const next = await hello(engine).catch(() => null);
      return next !== null && next.generation !== before.generation;
    }, "generation change after location reload", 45_000);
    const pickupMs = Date.now() - started;
    const after = await hello(engine);
    const afterEarly = await markerHello(engine, "bb.spike.early");
    const afterLater = await markerHello(engine, "bb.spike.later");
    note(
      `location reload pickup ${pickupMs}ms generation ${before.generation} -> ${after.generation} early ${beforeEarly} -> ${afterEarly} later ${beforeLater} -> ${afterLater} events ${eventTypes(events).join(",")}`,
    );
    expect(after.generation).not.toBe(before.generation);
    expect(afterEarly).not.toBe(beforeEarly);
    expect(afterLater).not.toBe(beforeLater);
    expect(events.some((event) => event.type === "location.shutdown")).toBe(true);
    const warningAt = live.warnings.length;
    await startTurn("thread-location-reload", providerThreadId, "call echo after reload");
    expect(live.warnings.slice(warningAt).some((message) => message.includes("reattached bb tools"))).toBe(true);
    await waitUntil(() => collectToolCalls(live).length === 1, "call after location reload");
    expect(model.requests.at(-1)?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
    answerToolCall(live, live.toolCalls[0]!, {
      success: true,
      contentItems: [{ type: "inputText", text: "echo: after" }],
    });
    await waitUntil(() => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes("echo: after"), "round trip after location reload");
    await subscription.stop();
  }, 180_000);

  it("falls back to native-only when the companion is removed during a claimed call", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;
    const beforeLater = await requireMarker(engine, "bb.spike.later");
    const beforeEarly = await requireMarker(engine, "bb.spike.early");
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "hold" } },
      { kind: "text", text: "native only" },
    );
    const providerThreadId = await startThread("thread-remove");
    await startTurn("thread-remove", providerThreadId, "call echo and hold");
    await waitUntil(() => collectToolCalls(live).length === 1, "claimed call");
    const path = configPath(engine);
    const original = readFileSync(path, "utf8");
    const parsed = JSON.parse(original) as { plugins?: string[] };
    parsed.plugins = (parsed.plugins ?? []).filter((plugin) => plugin !== companionDir);
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    try {
      const started = Date.now();
      await waitUntil(async () => {
        try {
          await hello(engine);
          return false;
        } catch {
          return true;
        }
      }, "companion hello to disappear", 45_000);
      const pickupMs = Date.now() - started;
      const afterEarly = await markerHello(engine, "bb.spike.early");
      const afterLater = await markerHello(engine, "bb.spike.later");
      note(
        `companion removal pickup ${pickupMs}ms early ${beforeEarly} -> ${afterEarly} later ${beforeLater} -> ${afterLater} events ${eventTypes(events).join(",")} plugins ${summarizePlugins(await pluginList(engine))}`,
      );
      expect(afterEarly).toBe(beforeEarly);
      expect(afterLater).not.toBe(beforeLater);
      await waitUntil(
        () =>
          sessionEvents(events, providerThreadId, "session.tool.failed").length > 0 &&
          sessionEvents(events, providerThreadId, "session.execution.failed").length > 0,
        "uncertain settlement",
      );
      assertUncertainSettlement(events, providerThreadId, callIdOf(live.toolCalls[0]!.params));
      note(`removal tool failure ${JSON.stringify(sessionEvents(events, providerThreadId, "session.tool.failed")[0]?.data)}`);
      note(`removal execution ${JSON.stringify(sessionEvents(events, providerThreadId, "session.execution.failed")[0]?.data)}`);
      answerToolCall(live, live.toolCalls[0]!, {
        success: true,
        contentItems: [{ type: "inputText", text: "echo: hold" }],
      });
      await waitUntil(
        () => live.warnings.some((message) => message.includes("not retrying")),
        "late result warning",
      );
      expect(collectToolCalls(live)).toHaveLength(1);
      await waitIdle(engine, providerThreadId);
      const beforeNative = model.requests.length;
      await startTurn("thread-remove", providerThreadId, "native turn");
      await waitUntil(() => model.requests.length > beforeNative, "native-only turn");
      const nativeRequest = model.requests.at(-1);
      expect(nativeRequest?.tools?.map((tool) => tool.function?.name) ?? []).not.toContain("bb_echo");
      expect(collectToolCalls(live)).toHaveLength(1);
      expect(
        deltaKinds(live, "thread-remove").some(
          (delta) => delta.kind === "provider.warning" && String(delta.details).includes("bb_echo"),
        ),
      ).toBe(true);
    } finally {
      writeFileSync(path, original);
      await subscription.stop();
    }
  }, 180_000);
});

describe.skipIf(engineBinary === undefined)("OpenCode incompatible companion", () => {
  const incompatible = createLiveContext({
    env: { BB_TOOLS_PROTOCOL_VERSION: "99" },
  });

  it("fails the turn with a setup error instead of running native-only", async () => {
    const { model, engine, live, startThread } = incompatible;
    const greeted = await hello(engine);
    note(`incompatible hello version ${greeted.version} generation ${greeted.generation}`);
    expect(greeted.version).toBe(99);
    const providerThreadId = await startThread("thread-incompatible");
    expect(
      deltaKinds(live, "thread-incompatible").some(
        (delta) => delta.kind === "provider.warning" && String(delta.summary).includes("does not run bb plugin tools"),
      ),
    ).toBe(false);
    const response = await rawTurn(live, 901, "thread-incompatible", providerThreadId, "should not start");
    note(`incompatible turn error ${response.error?.message ?? "missing"}`);
    expect(response.error?.message).toContain("protocol version 99");
    expect(response.error?.message).toContain("plugin add opencode-bb-tools");
    expect(model.requests).toHaveLength(0);
  }, 180_000);
});
