import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, expect } from "vitest";
import { createOpenCodeRuntime } from "../runtime/index.js";
import { createOpenCodeBridge } from "./bridge.js";
import { FULL_PERMISSION_OPTIONS } from "./test-support.js";

export const engineBinary = process.env.BB_OPENCODE_LIVE_ENGINE;
export const engineAppId = process.env.BB_OPENCODE_LIVE_APP ?? "shuvcode";
export const companionDir =
  process.env.BB_OPENCODE_LIVE_COMPANION ?? join(process.env.HOME ?? "", "repos/opencode-bb-tools");
export const password = "live-test-password";

const CLIENT_TURN_REQUEST_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const CLIENT_TURN_REQUEST_SUFFIX_LENGTH = 10;

export type ModelRequest = {
  tools?: Array<{
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

export type ScriptResponder = (req: ModelRequest) => ScriptStep | undefined;

export type ScriptStep =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

export interface MockModel {
  url: string;
  requests: ModelRequest[];
  allRequests: ModelRequest[];
  onRequest: Array<(req: ModelRequest) => void>;
  script: ScriptStep[];
  respond?: ScriptResponder;
  close(): Promise<void>;
}

export interface StartMockModelOptions {
  onRequest?: (req: ModelRequest) => void;
}

function sse(chunks: unknown[]): string {
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join("");
}

function engineAuthorization(): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export async function startMockModel(options: StartMockModelOptions = {}): Promise<MockModel> {
  const requests: ModelRequest[] = [];
  const allRequests: ModelRequest[] = [];
  const onRequest: Array<(req: ModelRequest) => void> = [];
  if (options.onRequest !== undefined) onRequest.push(options.onRequest);
  const script: ScriptStep[] = [];
  let respond: ScriptResponder | undefined;
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
      allRequests.push(parsed);
      for (const hook of onRequest) hook(parsed);
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
      const stepped = respond?.(parsed);
      const step = stepped ?? script.shift() ?? { kind: "text", text: "done" };
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
    allRequests,
    onRequest,
    script,
    get respond() {
      return respond;
    },
    set respond(value: ScriptResponder | undefined) {
      respond = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface Engine {
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

export function prepareEngineRoot(
  model: MockModel,
  plugins: string[],
  modelInput: string[] = ["text"],
): { root: string; workspace: string } {
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
              capabilities: { tools: true, input: modelInput, output: ["text"] },
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

export async function startEngine(root: string, workspace: string): Promise<Engine> {
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

export async function engineFetch(engine: Engine, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, engine.url), {
    ...init,
    headers: {
      authorization: engineAuthorization(),
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text}`);
  return text.length === 0 ? null : JSON.parse(text);
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export async function waitForCompanion(engine: Engine): Promise<unknown> {
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

export interface ToolCallRequest {
  id: string | number;
  params: Record<string, unknown>;
}

export interface LiveBridge {
  rpc: BridgeJsonRpcTestHarness;
  warnings: string[];
  toolCalls: ToolCallRequest[];
  answered: Set<string | number>;
  handleLine(line: string): void;
  teardown(): Promise<void>;
}

export async function startLiveBridge(engine: Engine): Promise<LiveBridge> {
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

export function collectToolCalls(live: LiveBridge): ToolCallRequest[] {
  for (const message of live.rpc.messages) {
    if (message.method !== "item/tool/call" || message.id === undefined || message.id === null) continue;
    if (live.toolCalls.some((call) => call.id === message.id)) continue;
    const params = message.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) continue;
    live.toolCalls.push({ id: message.id, params: params as Record<string, unknown> });
  }
  return live.toolCalls;
}

export function answerToolCall(live: LiveBridge, call: ToolCallRequest, result: unknown): void {
  live.answered.add(call.id);
  live.handleLine(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
}

export function deltaKinds(live: LiveBridge, threadId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of live.rpc.messages) {
    if (message.method !== "thread/delta") continue;
    const params = message.params as { threadId?: string; deltas?: Array<Record<string, unknown>> } | undefined;
    if (params?.threadId !== threadId || !Array.isArray(params.deltas)) continue;
    out.push(...params.deltas);
  }
  return out;
}

export const echoTool = {
  name: "bb_echo",
  description: "Echo text back through bb.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

export function toolMessages(request: ModelRequest): string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

export interface EngineEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface EngineEventSubscription {
  events: EngineEvent[];
  stop(): Promise<void>;
}

export function subscribeEngineEvents(engine: Engine): EngineEventSubscription {
  const events: EngineEvent[] = [];
  const abort = new AbortController();
  const done = (async () => {
    const response = await fetch(new URL("/api/event", engine.url), {
      headers: { authorization: engineAuthorization() },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
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
            events.push(JSON.parse(data) as EngineEvent);
          } catch {
            events.push({ type: "unparsed" });
          }
        }
        index = buffer.indexOf("\n\n");
      }
    }
  })().catch(() => undefined);
  return {
    events,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}

export interface StartThreadOptions {
  dynamicTools?: readonly DynamicTool[];
  cwd?: string;
  disallowedTools?: readonly string[];
  options?: BridgeJsonRpcObject;
}

export interface LiveContextOptions {
  plugins?: (companionDir: string) => string[];
  modelInput?: string[];
}

export interface LiveContext {
  readonly model: MockModel;
  readonly engine: Engine;
  readonly live: LiveBridge;
  startThread(threadId: string, opts?: StartThreadOptions): Promise<string>;
  startTurn(
    threadId: string,
    providerThreadId: string,
    text: string,
    options?: BridgeJsonRpcObject,
  ): Promise<void>;
  forkThread(threadId: string, sourceProviderThreadId: string, opts?: StartThreadOptions): Promise<string>;
}

function clientRequestIdFor(value: number): string {
  let remaining = value;
  let suffix = "";
  for (let index = 0; index < CLIENT_TURN_REQUEST_SUFFIX_LENGTH; index += 1) {
    const alphabetIndex = remaining % CLIENT_TURN_REQUEST_ALPHABET.length;
    suffix = CLIENT_TURN_REQUEST_ALPHABET.charAt(alphabetIndex) + suffix;
    remaining = Math.floor(remaining / CLIENT_TURN_REQUEST_ALPHABET.length);
  }
  return `creq_${suffix}`;
}

export function createLiveContext(options: LiveContextOptions = {}): LiveContext {
  const resolvePlugins = options.plugins ?? ((dir: string) => [dir]);
  const modelInput = options.modelInput ?? ["text"];
  let model: MockModel | undefined;
  let engine: Engine | undefined;
  let live: LiveBridge | undefined;
  let requestId = 10;

  beforeEach(async () => {
    model = await startMockModel();
    const prepared = prepareEngineRoot(model, resolvePlugins(companionDir), modelInput);
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
    live = undefined;
    engine = undefined;
    model = undefined;
  }, 30_000);

  function requireStarted(): { model: MockModel; engine: Engine; live: LiveBridge } {
    if (model === undefined || engine === undefined || live === undefined) {
      throw new Error("live context is not started");
    }
    return { model, engine, live };
  }

  return {
    get model() {
      return requireStarted().model;
    },
    get engine() {
      return requireStarted().engine;
    },
    get live() {
      return requireStarted().live;
    },
    async startThread(threadId, opts) {
      const started = requireStarted();
      requestId += 1;
      const id = requestId;
      started.live.rpc.sendRequest(id, "thread/start", {
        threadId,
        cwd: opts?.cwd ?? started.engine.workspace,
        instructionMode: "append",
        options: opts?.options ?? FULL_PERMISSION_OPTIONS,
        dynamicTools: opts?.dynamicTools ?? [echoTool],
        ...(opts?.disallowedTools !== undefined ? { disallowedTools: [...opts.disallowedTools] } : {}),
      } as unknown as BridgeJsonRpcObject);
      const response = await started.live.rpc.waitForResponse(id);
      expect(response.error).toBeUndefined();
      const result = response.result as { providerThreadId: string };
      return result.providerThreadId;
    },
    async startTurn(threadId, providerThreadId, text, options) {
      const started = requireStarted();
      requestId += 1;
      const id = requestId;
      started.live.rpc.sendRequest(id, "turn/start", {
        threadId,
        providerThreadId,
        input: [{ type: "text", text, mentions: [] }],
        clientRequestId: clientRequestIdFor(id),
        options: options ?? FULL_PERMISSION_OPTIONS,
      });
      const response = await started.live.rpc.waitForResponse(id);
      expect(response.error).toBeUndefined();
    },
    async forkThread(threadId, sourceProviderThreadId, opts) {
      const started = requireStarted();
      requestId += 1;
      const id = requestId;
      started.live.rpc.sendRequest(id, "thread/fork", {
        threadId,
        cwd: opts?.cwd ?? started.engine.workspace,
        sourceProviderThreadId,
        instructionMode: "append",
        options: opts?.options ?? FULL_PERMISSION_OPTIONS,
        dynamicTools: opts?.dynamicTools ?? [echoTool],
        ...(opts?.disallowedTools !== undefined ? { disallowedTools: [...opts.disallowedTools] } : {}),
      } as unknown as BridgeJsonRpcObject);
      const response = await started.live.rpc.waitForResponse(id);
      expect(response.error).toBeUndefined();
      const result = response.result as { providerThreadId: string };
      return result.providerThreadId;
    },
  };
}
