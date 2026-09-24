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
  subscribeEngineEvents,
  toolMessages,
  waitUntil,
} from "./companion-engine.live-harness.js";

describe.skipIf(engineBinary === undefined)("OpenCode companion live engine", () => {
  const ctx = createLiveContext();

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
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "boom" } }, { kind: "text", text: "done" });
    const subscription = subscribeEngineEvents(engine);
    const events = subscription.events;

    const providerThreadId = await startThread("thread-failure");
    await startTurn("thread-failure", providerThreadId, "call the echo tool and fail");
    await waitUntil(() => collectToolCalls(live).length === 1, "reverse item/tool/call");
    answerToolCall(live, live.toolCalls[0], {
      success: false,
      contentItems: [
        { type: "inputText", text: "first failure block" },
        { type: "inputText", text: "second failure block" },
        { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    });
    await waitUntil(() => model.requests.length >= 2, "model continuation after failure");
    await waitUntil(() => events.some((event) => event.type === "session.tool.failed"), "session.tool.failed");
    await subscription.stop();

    const failed = events.find((event) => event.type === "session.tool.failed");
    const failureText = toolMessages(model.requests[1]).join("\n");
    process.stderr.write(`\nLIVE failure event: ${JSON.stringify(failed?.data)}\nLIVE model sees: ${failureText}\n`);
    expect(failureText).toContain("first failure block");
    expect(failureText).toContain("second failure block");
    expect(failureText).toContain("1 image(s) omitted");
    expect(JSON.stringify(failed?.data)).toContain("omittedImages");
  }, 120_000);

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
    await waitUntil(async () => {
      const info = (await engineFetch(engine, `/api/session/${providerThreadId}`)) as {
        status?: { type?: string };
      };
      return info.status?.type !== "busy";
    }, "first turn to settle");
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
});
