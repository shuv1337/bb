import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerToolCall,
  collectToolCalls,
  createLiveContext,
  deltaKinds,
  engineBinary,
  engineFetch,
  engineRpc,
  subscribeEngineEvents,
  waitForSessionIdle,
  toolMessages,
  waitUntil,
  type Engine,
  type ModelRequest,
} from "./companion-engine.live-harness.js";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function readCompanionHello(engine: Engine): Promise<Record<string, unknown>> {
  const response = await engineRpc(engine, "hello", {});
  const parsed = recordOf(JSON.parse(response.body));
  const output = recordOf(parsed?.output) ?? recordOf(parsed?.data) ?? parsed;
  if (output?.protocol !== "bb.tools.v1") {
    throw new Error(`companion hello missing protocol: ${response.body.slice(0, 800)}`);
  }
  return output;
}

function imageMediaUrls(request: ModelRequest): string[] {
  const urls: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = recordOf(value);
    if (record === undefined) return;
    if (record.type === "image_url") {
      const image = recordOf(record.image_url);
      if (typeof image?.url === "string") urls.push(image.url);
    }
    for (const nested of Object.values(record)) walk(nested);
  };
  for (const message of request.messages) walk(message.content);
  return urls;
}

const REQUIRED_OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  providerOptions: { bbToolsRequired: true },
};

describe.skipIf(engineBinary === undefined)("OpenCode companion live engine", () => {
  const ctx = createLiveContext({ modelInput: ["text", "image"] });

  it("round-trips a direct bb tool call through companion RPC and the bridge", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "hello" } }, { kind: "text", text: "done" });
    const providerThreadId = await startThread("thread-roundtrip");
    await startTurn("thread-roundtrip", providerThreadId, "call the echo tool");

    await waitUntil(() => collectToolCalls(live).length === 1, "reverse item/tool/call");
    const [call] = live.toolCalls;
    expect(call.params).toMatchObject({
      providerThreadId,
      threadId: "thread-roundtrip",
      tool: "bb_echo",
      arguments: { text: "hello" },
      providerNativeIds: true,
    });
    answerToolCall(live, call, { success: true, contentItems: [{ type: "inputText", text: "echo: hello" }] });

    await waitUntil(() => model.requests.length >= 2, "model continuation after tool result");
    expect(model.requests[0].tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
    expect(model.requests[0].tools?.some((tool) => tool.function?.name?.startsWith("bbt_"))).toBe(false);
    expect(toolMessages(model.requests[1]).join("\n")).toContain("echo: hello");
    expect(
      deltaKinds(live, "thread-roundtrip").some(
        (delta) => delta.kind === "provider.warning" && String(delta.summary).includes("does not run bb plugin tools"),
      ),
    ).toBe(false);
  }, 120_000);

  it("reports a bb failure as a failed native tool with metadata", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const hello = await readCompanionHello(engine);
    const richFailures = recordOf(hello.features)?.richFailures === true;
    expect(typeof recordOf(hello.features)?.richFailures).toBe("boolean");
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "boom" } }, { kind: "text", text: "done" });
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;

    const providerThreadId = await startThread("thread-failure");
    await startTurn("thread-failure", providerThreadId, "call the echo tool and fail");
    await waitUntil(() => collectToolCalls(live).length === 1, "reverse item/tool/call");
    const callId = String(live.toolCalls[0]?.params.callId);
    answerToolCall(live, live.toolCalls[0], {
      success: false,
      contentItems: [
        { type: "inputText", text: "first failure block" },
        { type: "inputText", text: "second failure block" },
        { type: "inputImage", imageUrl: PNG },
      ],
    });
    await waitUntil(() => model.requests.length >= 2, "model continuation after failure");
    await waitUntil(
      () => events.some((event) => event.type === "session.tool.failed" && event.data?.id === callId),
      "session.tool.failed",
    );
    await subscription.stop();

    const failed = events.find((event) => event.type === "session.tool.failed" && event.data?.id === callId);
    const next = model.requests.find((request) => toolMessages(request).some((text) => text.includes("first failure block")));
    const failureText = toolMessages(next ?? { messages: [] }).join("\n");
    const messages = next?.messages ?? [];
    const toolIndex = messages.findIndex(
      (message) => message.role === "tool" && String(message.content).includes("first failure block"),
    );
    const follow = messages[toolIndex + 1];
    const failedState = deltaKinds(live, "thread-failure").some(
      (delta) => delta.kind === "item.close" && delta.status === "failed",
    );
    process.stderr.write(
      `\nLIVE richFailures=${richFailures} failure event: ${JSON.stringify(failed?.data)}\nLIVE model sees: ${failureText}\nLIVE failure follow: ${JSON.stringify(follow)}\n`,
    );
    expect(failedState).toBe(true);
    expect(events.some((event) => event.type === "session.tool.success" && event.data?.id === callId)).toBe(false);
    expect(failureText).toContain("first failure block");
    expect(failureText).toContain("second failure block");
    if (richFailures) {
      expect(failureText).not.toContain("data:");
      expect(failureText).not.toContain("image(s) omitted");
      expect(failureText).not.toContain("Cannot read image");
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(follow?.role).toBe("user");
      expect(follow?.content).toEqual([{ type: "image_url", image_url: { url: PNG } }]);
      const raw = JSON.stringify(failed?.data);
      expect(raw).toContain('"type":"file"');
      expect(raw).toContain('"mime":"image/png"');
      expect(raw).toContain("first failure block");
      expect(raw).toContain("second failure block");
      expect(raw).not.toContain("omittedImages");
    } else {
      expect(failureText).toContain("1 image(s) omitted");
      expect(failureText).toContain("engine lacks rich tool errors");
      expect(imageMediaUrls(next ?? { messages: [] })).toEqual([]);
      expect(JSON.stringify(failed?.data)).toContain("omittedImages");
    }
  }, 120_000);

  it("fails an oversized bb result once and still delivers 120 KiB", async () => {
    const { model, engine, live, startThread, startTurn } = ctx;
    const hello = await readCompanionHello(engine);
    const maxResultBytes = recordOf(hello.limits)?.maxResultBytes;
    if (typeof maxResultBytes !== "number") {
      throw new Error(`companion hello missing maxResultBytes: ${JSON.stringify(hello.limits)}`);
    }
    expect(maxResultBytes).toBeGreaterThan(120 * 1024);
    const limit = maxResultBytes;
    const wrapper = Buffer.byteLength(JSON.stringify([{ type: "inputText", text: "" }]), "utf8");
    const oversized = "y".repeat(limit - wrapper + 1);
    expect(Buffer.byteLength(JSON.stringify([{ type: "inputText", text: oversized }]), "utf8")).toBeGreaterThan(limit);
    const kept = "k".repeat(120 * 1024);
    const limitMessage = `bb tool result exceeded the companion limit of ${limit} bytes`;
    model.script.push(
      { kind: "tool", name: "bb_echo", args: { text: "huge" } },
      { kind: "tool", name: "bb_echo", args: { text: "kept" } },
      { kind: "text", text: "done" },
    );
    const subscription = subscribeEngineEvents(engine);
    const providerThreadId = await startThread("thread-oversized");
    await startTurn("thread-oversized", providerThreadId, "return an oversized result");
    await waitUntil(() => collectToolCalls(live).length === 1, "oversized reverse call");
    const failedCallId = String(live.toolCalls[0]?.params.callId);
    answerToolCall(live, live.toolCalls[0], {
      success: true,
      contentItems: [{ type: "inputText", text: oversized }],
    });
    await waitUntil(
      () => toolMessages(model.requests.at(-1) ?? { messages: [] }).join("\n").includes(limitMessage),
      "oversized failure delivered to the model",
    );
    await waitUntil(
      () => subscription.events.some((event) => event.type === "session.tool.failed" && event.data?.id === failedCallId),
      "oversized session.tool.failed",
    );
    await waitUntil(() => collectToolCalls(live).length === 2, "120 KiB reverse call");
    answerToolCall(live, live.toolCalls[1], {
      success: true,
      contentItems: [{ type: "inputText", text: kept }],
    });
    await waitUntil(
      () => model.requests.some((request) => toolMessages(request).join("\n").includes(kept)),
      "120 KiB continuation",
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    await subscription.stop();

    const failed = subscription.events.find(
      (event) => event.type === "session.tool.failed" && event.data?.id === failedCallId,
    );
    const failureRequest = model.requests.find((request) =>
      toolMessages(request).some((text) => text.includes(limitMessage)),
    );
    const failureText = toolMessages(failureRequest ?? { messages: [] }).join("\n");
    const keptRequest = model.requests.find((request) => toolMessages(request).some((text) => text.includes(kept)));
    const keptTool = toolMessages(keptRequest ?? { messages: [] }).find((text) => text.includes(kept));
    process.stderr.write(
      `\nLIVE oversized failure: ${JSON.stringify(failed?.data)}\nLIVE oversized model sees: ${failureText.slice(0, 400)}\nLIVE kept bytes: ${keptTool === undefined ? "missing" : Buffer.byteLength(keptTool, "utf8")}\n`,
    );
    expect(failureText).toContain(limitMessage);
    expect(failureText).not.toContain(oversized.slice(0, 64));
    expect(JSON.stringify(failed?.data)).toContain(limitMessage);
    expect(subscription.events.some((event) => event.type === "session.tool.success" && event.data?.id === failedCallId)).toBe(
      false,
    );
    expect(collectToolCalls(live)).toHaveLength(2);
    expect(
      live.warnings.filter(
        (message) => message.includes("could not deliver bb tool result") || message.includes("undeliverable"),
      ),
    ).toEqual([]);
    expect(keptTool).toContain(kept);
    expect(keptTool).not.toContain("truncated");
    expect(keptTool).not.toMatch(/saved to /);
    expect(keptTool).not.toContain(limitMessage);
  }, 180_000);

  it("rejects bb tools invoked from inside Code Mode without dispatching to bb", async () => {
    const { model, live, startThread, startTurn } = ctx;
    const code = [
      "const names = Object.keys(tools).filter((name) => name.startsWith('bbt_') || name === 'bb_echo');",
      "const calls = names.flatMap((name) => [tools[name]({ text: 'a' }), tools[name]({ text: 'b' })]);",
      "const settled = await Promise.allSettled(calls);",
      "return JSON.stringify({ names, keys: Object.keys(tools).slice(0, 40), settled: settled.map((item) => item.status === 'fulfilled' ? 'ok:' + String(item.value) : 'err:' + String(item.reason && (item.reason.message || item.reason))) });",
    ].join("\n");
    model.script.push({ kind: "tool", name: "execute", args: { code } }, { kind: "text", text: "done" });
    const providerThreadId = await startThread("thread-codemode");
    await startTurn("thread-codemode", providerThreadId, "use code mode");

    await waitUntil(() => model.requests.length >= 2, "model continuation after execute");
    const output = toolMessages(model.requests[1]).join("\n");
    process.stderr.write(`\nLIVE code mode output: ${output}\n`);
    expect(collectToolCalls(live)).toHaveLength(0);
    expect(output).not.toMatch(/ok:/);
    if (/bbt_/.test(output)) {
      expect(output).toMatch(/can only be called directly by the model/);
    }
  }, 120_000);

  it("moves a bound session to a new directory and keeps working there", async () => {
    const { model, engine, startThread, startTurn } = ctx;
    model.script.push({ kind: "text", text: "first" }, { kind: "text", text: "second" });
    const providerThreadId = await startThread("thread-move");
    await startTurn("thread-move", providerThreadId, "first turn");
    await waitUntil(() => model.requests.length >= 1, "first turn");
    const target = join(engine.root, "moved");
    mkdirSync(target, { recursive: true });
    await waitForSessionIdle(engine, providerThreadId);
    await engineFetch(engine, `/api/session/${providerThreadId}/move`, {
      method: "POST",
      body: JSON.stringify({ directory: target }),
    });
    let lastInfo: unknown = null;
    await waitUntil(async () => {
      const info = await engineFetch(engine, `/api/session/${providerThreadId}`);
      lastInfo = info;
      return JSON.stringify(info).includes(JSON.stringify(target));
    }, "session location to change", 20_000).catch((error: unknown) => {
      throw new Error(`${String(error)}; last session info: ${JSON.stringify(lastInfo)}`);
    });
    await startTurn("thread-move", providerThreadId, "second turn after move");
    await waitUntil(() => model.requests.length >= 2, "second turn after move");
    const after = model.requests[1];
    const tools = after.tools?.map((tool) => tool.function?.name) ?? [];
    process.stderr.write(`\nLIVE after move tools: ${JSON.stringify(tools)}\n`);
    expect(JSON.stringify(after.messages)).toContain("first turn");
    expect(JSON.stringify(after.messages)).toContain("second turn after move");
  }, 120_000);

  it("runs bb tools when they are required and the companion is present", async () => {
    const { model, live, startThread, startTurn } = ctx;
    model.script.push({ kind: "text", text: "required present" });
    const providerThreadId = await startThread("thread-required", { options: REQUIRED_OPTIONS });
    await startTurn("thread-required", providerThreadId, "required present", REQUIRED_OPTIONS);
    await waitUntil(() => model.requests.some((item) => JSON.stringify(item.messages).includes("required present")), "required turn");
    expect(model.requests.at(-1)?.tools?.map((tool) => tool.function?.name)).toContain("bb_echo");
    expect(
      deltaKinds(live, "thread-required").some(
        (delta) => delta.kind === "provider.warning" && String(delta.summary).includes("does not run bb plugin tools"),
      ),
    ).toBe(false);
  }, 120_000);
});

describe.skipIf(engineBinary === undefined)("OpenCode bb tools required without a companion", () => {
  const absent = createLiveContext({ plugins: () => [], requireCompanion: false });

  it("warns and stays native-only when bb tools are not required", async () => {
    const { model, live, startThread, startTurn } = absent;
    model.script.push({ kind: "text", text: "native only" });
    const providerThreadId = await startThread("thread-optional-absent");
    expect(JSON.stringify(deltaKinds(live, "thread-optional-absent"))).toContain("Dropped dynamicTools: bb_echo");
    await startTurn("thread-optional-absent", providerThreadId, "native only");
    await waitUntil(() => model.requests.length > 0, "native turn");
    expect(model.requests[0]?.tools?.map((tool) => tool.function?.name) ?? []).not.toContain("bb_echo");
  }, 120_000);

  it("fails the turn when bb tools are required and the companion is absent", async () => {
    const { model, live, startThread, request } = absent;
    const providerThreadId = await startThread("thread-required-absent", { options: REQUIRED_OPTIONS });
    expect(
      deltaKinds(live, "thread-required-absent").some(
        (delta) => delta.kind === "provider.warning" && String(delta.summary).includes("does not run bb plugin tools"),
      ),
    ).toBe(false);
    const response = await request("turn/start", {
      threadId: "thread-required-absent",
      providerThreadId,
      input: [{ type: "text", text: "should not start", mentions: [] }],
      clientRequestId: "creq_23456789af",
      options: REQUIRED_OPTIONS,
    });
    expect(JSON.stringify(response.error)).toContain("bb tools are required");
    expect(JSON.stringify(response.error)).toContain("opencode-bb-tools");
    expect(model.requests).toHaveLength(0);
  }, 120_000);
});
