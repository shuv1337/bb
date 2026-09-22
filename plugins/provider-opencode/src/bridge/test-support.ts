import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcId,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOpenCodeBridge } from "./bridge.js";
import type {
  OpenCodeDiscoveryHealth,
  OpenCodeRuntime as LiveOpenCodeRuntime,
} from "../runtime/index.js";
import type {
  CreateSessionInput,
  OpenCodeEvent,
  OpenCodeFileAttachment,
  OpenCodeMessage,
  OpenCodeModelRef,
  OpenCodePermissionRuleset,
  OpenCodePromptInput,
  OpenCodeRuntime,
  SessionHandle,
} from "./runtime-api.js";

export const FULL_PERMISSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  take(signal: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      });
    });
  }
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  if (event.data === null || typeof event.data !== "object") {
    return undefined;
  }
  const sessionID = (event.data as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

function eventParentID(event: OpenCodeEvent): string | undefined {
  if (event.data === null || typeof event.data !== "object") {
    return undefined;
  }
  const parentID = (event.data as { parentID?: unknown }).parentID;
  return typeof parentID === "string" ? parentID : undefined;
}

export class FakeOpenCodeRuntime implements OpenCodeRuntime {
  readonly sessions = new Map<string, FakeSessionHandle>();
  readonly emitted: OpenCodeEvent[] = [];
  lastForkBefore: string | undefined;
  lastPrompt: OpenCodePromptInput | undefined;
  lastCommand: { name: string; text: string } | undefined;
  lastEnv: Record<string, string> | undefined;
  lastInstructions: { key: string; value: string } | undefined;
  lastPermissions: OpenCodePermissionRuleset | undefined;
  lastAgent: string | undefined;
  lastModel: OpenCodeModelRef | undefined;
  lastTitle: string | undefined;
  closed = false;
  nextId = 0;
  private readonly subscribers: Array<{
    sessionID: string;
    queue: AsyncQueue<OpenCodeEvent>;
  }> = [];

  emit(event: OpenCodeEvent): void {
    this.emitted.push(event);
    const sessionID = eventSessionID(event);
    const parentID = eventParentID(event);
    for (const subscriber of this.subscribers) {
      if (
        subscriber.sessionID === sessionID ||
        (parentID !== undefined && subscriber.sessionID === parentID)
      ) {
        subscriber.queue.push(event);
      }
    }
  }

  async info(): Promise<{ version: string; url?: string }> {
    return { version: "2.0.11", url: "http://127.0.0.1:4096" };
  }

  async models(): Promise<
    { id: string; providerID: string; name: string; variants: { id: string }[] }[]
  > {
    return [
      {
        id: "gemini-3.7-flash-high",
        providerID: "google",
        name: "Gemini 3.7 Flash High",
        variants: [],
      },
    ];
  }

  async defaultModel(): Promise<{
    id: string;
    providerID: string;
    name: string;
    variants: { id: string }[];
  }> {
    return {
      id: "gemini-3.7-flash-high",
      providerID: "google",
      name: "Gemini 3.7 Flash High",
      variants: [],
    };
  }

  async agents(): Promise<{ name: string; mode: string }[]> {
    return [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary" },
    ];
  }

  async skills(): Promise<{ id: string; name: string }[]> {
    return [{ id: "m0-probe", name: "m0-probe" }];
  }

  async commands(): Promise<{ name: string }[]> {
    return [{ name: "init" }];
  }

  async createSession(input: CreateSessionInput): Promise<SessionHandle> {
    this.nextId += 1;
    const handle = new FakeSessionHandle(this, {
      id: `ses_${this.nextId}`,
      directory: input.directory,
      metadata: input.metadata,
      messages: [],
    });
    this.sessions.set(handle.id, handle);
    this.lastAgent = input.agent;
    this.lastModel = input.model;
    this.lastPermissions = input.permissions;
    this.lastTitle = input.title;
    this.emit({
      type: "session.created",
      data: {
        sessionID: handle.id,
        title: input.title,
        metadata: input.metadata,
        location: { directory: input.directory },
      },
      durable: { seq: 0 },
    });
    return handle;
  }

  async openSession(sessionID: string): Promise<SessionHandle> {
    const existing = this.sessions.get(sessionID);
    if (existing === undefined) {
      throw new Error(`Session not found: ${sessionID}`);
    }
    return existing;
  }

  subscribe(sessionID: string, signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const queue = new AsyncQueue<OpenCodeEvent>();
    const subscriber = { sessionID, queue };
    this.subscribers.push(subscriber);
    const runtime = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            yield await queue.take(signal);
          }
        } finally {
          const index = runtime.subscribers.indexOf(subscriber);
          if (index >= 0) {
            runtime.subscribers.splice(index, 1);
          }
        }
      },
    };
  }

  async health(): Promise<OpenCodeDiscoveryHealth> {
    return {
      status: "ready",
      statusMessage: null,
      appId: "opencode",
      version: "2.0.11",
      installedVersion: "2.0.11",
      url: "http://127.0.0.1:4096",
      registrationFile: null,
      pid: 1,
      pathBinaryAppId: "opencode",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSessionHandle implements SessionHandle {
  holding = false;
  private messageSerial = 0;

  constructor(
    private readonly runtime: FakeOpenCodeRuntime,
    readonly info: {
      id: string;
      directory: string;
      metadata: { bbThreadId?: string };
      messages: OpenCodeMessage[];
    },
  ) {}

  get id(): string {
    return this.info.id;
  }

  get directory(): string {
    return this.info.directory;
  }

  get metadata(): { readonly bbThreadId?: string } {
    return this.info.metadata;
  }

  private nextMessageId(): string {
    this.messageSerial += 1;
    return `msg_${this.id}_${this.messageSerial}`;
  }

  async prompt(input: OpenCodePromptInput): Promise<{ id: string }> {
    this.runtime.lastPrompt = input;
    const id = input.id ?? this.nextMessageId();
    this.info.messages.push({ id, type: "user" });
    const assistantId = this.nextMessageId();
    this.runtime.emit({
      type: "session.execution.started",
      data: { sessionID: this.id },
      durable: { seq: this.info.messages.length },
    });
    if (input.text.includes("/hold")) {
      this.holding = true;
      return { id };
    }
    this.runtime.emit({
      type: "session.text.started",
      data: { sessionID: this.id, assistantMessageID: assistantId, ordinal: 0 },
      durable: { seq: this.info.messages.length + 1 },
    });
    this.runtime.emit({
      type: "session.text.delta",
      data: {
        sessionID: this.id,
        assistantMessageID: assistantId,
        ordinal: 0,
        delta: `echo:${input.text}`,
      },
    });
    this.runtime.emit({
      type: "session.text.ended",
      data: {
        sessionID: this.id,
        assistantMessageID: assistantId,
        ordinal: 0,
        text: `echo:${input.text}`,
      },
      durable: { seq: this.info.messages.length + 2 },
    });
    this.info.messages.push({ id: assistantId, type: "assistant" });
    this.runtime.emit({
      type: "session.usage.updated",
      data: {
        sessionID: this.id,
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    this.runtime.emit({
      type: "session.execution.succeeded",
      data: { sessionID: this.id },
      durable: { seq: this.info.messages.length + 3 },
    });
    return { id };
  }

  async command(input: { name: string; text: string; files?: readonly OpenCodeFileAttachment[] }): Promise<void> {
    this.runtime.lastCommand = { name: input.name, text: input.text };
    await this.prompt({ text: input.text, files: input.files, delivery: "steer" });
  }

  async compact(): Promise<void> {
    this.runtime.emit({
      type: "session.compaction.started",
      data: { sessionID: this.id, reason: "manual", recent: "", inputID: "msg_compact" },
      durable: { seq: 1 },
    });
    this.runtime.emit({
      type: "session.compaction.ended",
      data: { sessionID: this.id, reason: "manual", text: "summary" },
      durable: { seq: 2 },
    });
  }

  async interrupt(): Promise<void> {
    this.holding = false;
    this.runtime.emit({
      type: "session.execution.interrupted",
      data: { sessionID: this.id },
      durable: { seq: 99 },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  async switchAgent(agent: string): Promise<void> {
    this.runtime.lastAgent = agent;
  }

  async switchModel(model: OpenCodeModelRef): Promise<void> {
    this.runtime.lastModel = model;
  }

  async update(patch: { title?: string; permissions?: OpenCodePermissionRuleset }): Promise<void> {
    if (patch.title !== undefined) {
      this.runtime.lastTitle = patch.title;
    }
    if (patch.permissions !== undefined) {
      this.runtime.lastPermissions = patch.permissions;
    }
  }

  async fork(before?: string): Promise<SessionHandle> {
    this.runtime.lastForkBefore = before;
    this.runtime.nextId += 1;
    const copied =
      before === undefined
        ? [...this.info.messages]
        : this.info.messages.slice(
            0,
            Math.max(
              0,
              this.info.messages.findIndex((message) => message.id === before),
            ),
          );
    const handle = new FakeSessionHandle(this.runtime, {
      id: `ses_${this.runtime.nextId}`,
      directory: this.info.directory,
      metadata: { ...this.info.metadata },
      messages: copied,
    });
    this.runtime.sessions.set(handle.id, handle);
    return handle;
  }

  async replyPermission(): Promise<void> {}

  async replyForm(): Promise<void> {}

  async setEnvironment(env: Record<string, string>): Promise<void> {
    this.runtime.lastEnv = env;
  }

  async putInstructionEntry(key: string, value: string): Promise<void> {
    this.runtime.lastInstructions = { key, value };
  }

  async context(): Promise<readonly OpenCodeMessage[]> {
    return this.info.messages;
  }
}

export interface OpenCodeBridgeHarness {
  workspaceDir: string;
  fake: FakeOpenCodeRuntime;
  rpc: BridgeJsonRpcTestHarness;
  request(
    id: BridgeJsonRpcId,
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  startThread(threadId: string, extra?: BridgeJsonRpcObject): Promise<BridgeJsonRpcOutputMessage>;
  deltasOf(threadId: string): Record<string, unknown>[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  teardown(): Promise<void>;
}

export async function startOpenCodeBridgeHarness(): Promise<OpenCodeBridgeHarness> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "bb-opencode-bridge-"));
  const fake = new FakeOpenCodeRuntime();
  const bridge = createOpenCodeBridge({
    createRuntime: async () => fake as unknown as LiveOpenCodeRuntime,
  });
  const rpc = createBridgeJsonRpcTestHarness(bridge.handleLine);
  let requestId = 1;
  const initialize = await rpc.waitForResponse(
    (() => {
      const id = requestId;
      requestId += 1;
      rpc.sendRequest(id, "initialize", {
        protocolVersion: 2,
        client: { name: "test", version: "1" },
        grammarVersions: [3, 3],
      });
      return id;
    })(),
  );
  if (initialize.error !== undefined) {
    throw new Error(`initialize failed: ${JSON.stringify(initialize.error)}`);
  }

  function deltasOf(threadId: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const message of rpc.messages) {
      if (message.method !== "thread/delta") {
        continue;
      }
      const params = message.params;
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        continue;
      }
      const record = params as { threadId?: unknown; deltas?: unknown };
      if (record.threadId !== threadId || !Array.isArray(record.deltas)) {
        continue;
      }
      for (const delta of record.deltas) {
        if (delta !== null && typeof delta === "object") {
          out.push(delta as Record<string, unknown>);
        }
      }
    }
    return out;
  }

  return {
    workspaceDir,
    fake,
    rpc,
    async request(id, method, params) {
      rpc.sendRequest(id, method, params);
      return rpc.waitForResponse(id);
    },
    async startThread(threadId, extra) {
      const id = requestId;
      requestId += 1;
      rpc.sendRequest(id, "thread/start", {
        threadId,
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        ...(extra ?? {}),
      });
      return rpc.waitForResponse(id);
    },
    deltasOf,
    async waitFor(predicate, what) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await rpc.flushWork();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      throw new Error(`Timed out waiting for ${what}`);
    },
    async teardown() {
      await bridge.closeAll();
      rpc.restore();
    },
  };
}
