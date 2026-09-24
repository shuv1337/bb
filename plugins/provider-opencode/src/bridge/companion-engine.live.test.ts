import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCodeRuntime } from "../runtime/index.js";
import { createOpenCodeBridge } from "./bridge.js";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";

const engineBinary = process.env.BB_OPENCODE_LIVE_ENGINE;
const engineAppId = process.env.BB_OPENCODE_LIVE_APP ?? "shuvcode";
const companionDir =
  process.env.BB_OPENCODE_LIVE_COMPANION ?? join(process.env.HOME ?? "", "repos/opencode-bb-tools");
const password = "live-test-password";

type ModelRequest = {
  tools?: Array<{ function?: { name?: string } }>;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

type ScriptStep =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

interface MockModel {
  url: string;
  requests: ModelRequest[];
  script: ScriptStep[];
  close(): Promise<void>;
}

function sse(chunks: unknown[]): string {
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join("");
}

async function startMockModel(): Promise<MockModel> {
  const requests: ModelRequest[] = [];
  const script: ScriptStep[] = [];
  let callSerial = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (body.length === 0) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = JSON.parse(body) as ModelRequest;
      const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
        res.end(
          sse([
            { choices: [{ delta: { role: "assistant", content: "Live test" }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            usage,
          ]),
        );
        return;
      }
      requests.push(parsed);
      const step = script.shift() ?? { kind: "text", text: "done" };
      if (step.kind === "text") {
        res.end(
          sse([
            { choices: [{ delta: { role: "assistant", content: step.text }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            usage,
          ]),
        );
        return;
      }
      callSerial += 1;
      res.end(
        sse([
          {
            choices: [
              {
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_live_${callSerial}`,
                      type: "function",
                      function: { name: step.name, arguments: JSON.stringify(step.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          usage,
        ]),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock model has no port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    script,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Engine {
  url: string;
  root: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  process: ChildProcessWithoutNullStreams;
  stderr: string[];
  stop(): Promise<void>;
}

function engineEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: join(root, "models.json"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

function prepareEngineRoot(model: MockModel, plugins: string[]): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "bb-oc-live-"));
  const workspace = join(root, "work");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, "config", engineAppId), { recursive: true });
  writeFileSync(join(root, "models.json"), "{}");
  writeFileSync(
    join(root, "config", engineAppId, "opencode.json"),
    JSON.stringify({
      update: "disable",
      model: "mock/scripted",
      plugins,
      providers: {
        mock: {
          name: "Mock",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "x", baseURL: model.url },
          models: {
            scripted: {
              name: "Scripted",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0 },
              limit: { context: 100000, output: 10000 },
            },
          },
        },
      },
    }),
  );
  return { root, workspace };
}

async function startEngine(root: string, workspace: string): Promise<Engine> {
  if (engineBinary === undefined) throw new Error("BB_OPENCODE_LIVE_ENGINE is not set");
  const env = engineEnv(root);
  const child = spawn(engineBinary, ["serve", "--stdio", "--port", "0"], { env, cwd: workspace });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`engine did not start: ${stderr.join("")}`)), 30_000);
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { url?: string };
        if (typeof parsed.url === "string") {
          clearTimeout(timer);
          resolve(parsed.url);
        }
      } catch {
        return;
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`engine exited ${code}: ${stderr.join("")}`));
    });
  });
  return {
    url,
    root,
    workspace,
    env,
    process: child,
    stderr,
    stop: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function engineFetch(engine: Engine, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, engine.url), {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text}`);
  return text.length === 0 ? null : JSON.parse(text);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function waitForCompanion(engine: Engine): Promise<unknown> {
  let last: unknown = null;
  await waitUntil(async () => {
    try {
      last = await engineFetch(
        engine,
        `/api/rpc/bb.tools.v1/hello?location[directory]=${encodeURIComponent(engine.workspace)}`,
        { method: "POST", body: JSON.stringify({ input: {} }) },
      );
      return true;
    } catch (error) {
      last = error;
      return false;
    }
  }, "companion hello");
  return last;
}

interface ToolCallRequest {
  id: string | number;
  params: Record<string, unknown>;
}

interface LiveBridge {
  rpc: BridgeJsonRpcTestHarness;
  warnings: string[];
  toolCalls: ToolCallRequest[];
  answered: Set<string | number>;
  handleLine(line: string): void;
  teardown(): Promise<void>;
}

async function startLiveBridge(engine: Engine): Promise<LiveBridge> {
  const warnings: string[] = [];
  const bridge = createOpenCodeBridge({
    createRuntime: async () =>
      createOpenCodeRuntime({
        env: { OPENCODE_SERVER_URL: engine.url, OPENCODE_SERVER_PASSWORD: password },
      }),
    warn: (message) => {
      warnings.push(message);
    },
  });
  const dataDir = join(engine.root, "bridge-data");
  mkdirSync(dataDir, { recursive: true });
  bridge.experimental_providerBridge.start?.({ pluginId: "provider-opencode", dataDir, tempDir: dataDir });
  const rpc = createBridgeJsonRpcTestHarness(bridge.handleLine);
  rpc.sendRequest(1, "initialize", {
    protocolVersion: 2,
    client: { name: "live", version: "1" },
    grammarVersions: [3, 3],
  });
  await rpc.waitForResponse(1);
  const toolCalls: ToolCallRequest[] = [];
  return {
    rpc,
    warnings,
    toolCalls,
    answered: new Set(),
    handleLine: bridge.handleLine,
    teardown: async () => {
      await bridge.closeAll();
      rpc.restore();
    },
  };
}

function collectToolCalls(live: LiveBridge): ToolCallRequest[] {
  for (const message of live.rpc.messages) {
    if (message.method !== "item/tool/call" || message.id === undefined || message.id === null) continue;
    if (live.toolCalls.some((call) => call.id === message.id)) continue;
    const params = message.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) continue;
    live.toolCalls.push({ id: message.id, params: params as Record<string, unknown> });
  }
  return live.toolCalls;
}

function answerToolCall(live: LiveBridge, call: ToolCallRequest, result: unknown): void {
  live.answered.add(call.id);
  live.handleLine(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
}

function deltaKinds(live: LiveBridge, threadId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of live.rpc.messages) {
    if (message.method !== "thread/delta") continue;
    const params = message.params as { threadId?: string; deltas?: Array<Record<string, unknown>> } | undefined;
    if (params?.threadId !== threadId || !Array.isArray(params.deltas)) continue;
    out.push(...params.deltas);
  }
  return out;
}

const echoTool = {
  name: "bb_echo",
  description: "Echo text back through bb.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

function toolMessages(request: ModelRequest): string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

describe.skipIf(engineBinary === undefined)("OpenCode companion live engine", () => {
  let model: MockModel;
  let engine: Engine;
  let live: LiveBridge;
  let requestId = 10;

  beforeEach(async () => {
    model = await startMockModel();
    const prepared = prepareEngineRoot(model, [companionDir]);
    engine = await startEngine(prepared.root, prepared.workspace);
    await waitForCompanion(engine);
    live = await startLiveBridge(engine);
  }, 90_000);

  afterEach(async () => {
    await live?.teardown();
    await engine?.stop();
    await model?.close();
    if (engine !== undefined && process.env.BB_OPENCODE_LIVE_KEEP === undefined) {
      rmSync(engine.root, { recursive: true, force: true });
    }
  }, 30_000);

  async function startThread(threadId: string): Promise<string> {
    requestId += 1;
    const id = requestId;
    live.rpc.sendRequest(id, "thread/start", {
      threadId,
      cwd: engine.workspace,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [echoTool],
    });
    const response = await live.rpc.waitForResponse(id);
    expect(response.error).toBeUndefined();
    const result = response.result as { providerThreadId: string };
    return result.providerThreadId;
  }

  async function startTurn(threadId: string, providerThreadId: string, text: string): Promise<void> {
    requestId += 1;
    const id = requestId;
    live.rpc.sendRequest(id, "turn/start", {
      threadId,
      providerThreadId,
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId: `creq_${"a".repeat(9)}${"23456789abcdefghijk"[requestId % 19]}`,
      options: FULL_PERMISSION_OPTIONS,
    });
    const response = await live.rpc.waitForResponse(id);
    expect(response.error).toBeUndefined();
  }

  it("round-trips a direct bb tool call through companion RPC and the bridge", async () => {
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
    model.script.push({ kind: "tool", name: "bb_echo", args: { text: "boom" } }, { kind: "text", text: "done" });
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const abort = new AbortController();
    const subscription = (async () => {
      const response = await fetch(new URL("/api/event", engine.url), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (data.length > 0) {
            try {
              events.push(JSON.parse(data));
            } catch {
              events.push({ type: "unparsed" });
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
    })().catch(() => undefined);

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
    abort.abort();
    await subscription;

    const failed = events.find((event) => event.type === "session.tool.failed");
    const failureText = toolMessages(model.requests[1]).join("\n");
    process.stderr.write(`\nLIVE failure event: ${JSON.stringify(failed?.data)}\nLIVE model sees: ${failureText}\n`);
    expect(failureText).toContain("first failure block");
    expect(failureText).toContain("second failure block");
    expect(failureText).toContain("1 image(s) omitted");
    expect(JSON.stringify(failed?.data)).toContain("omittedImages");
  }, 120_000);

  it("rejects bb tools invoked from inside Code Mode without dispatching to bb", async () => {
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
