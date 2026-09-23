import { describe, expect, it, vi } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOpenCodeBridge, UNOPENED_DISPATCH_GRACE_MS } from "./bridge.js";
import {
  createFakeOpenCodeRuntime,
  type OpenCodePromptInput,
  type OpenCodeRuntime,
  type OpenCodeSkill,
  type RuntimeSessionEvent,
} from "../runtime/index.js";

const CWD = "/tmp/opencode-dispatch";
const SKILLS: OpenCodeSkill[] = [
  { id: "known", name: "Known", path: "/skills/known" },
];

function executionOptions(): BridgeJsonRpcObject {
  return {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    providerOptions: { agent: null },
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

function threadDeltas(
  messages: readonly BridgeJsonRpcOutputMessage[],
  threadId: string,
): Array<Record<string, JsonValue>> {
  const deltas: Array<Record<string, JsonValue>> = [];
  for (const message of messages) {
    if (message.method !== "thread/delta") continue;
    const params = message.params;
    if (!isRecord(params) || params.threadId !== threadId) continue;
    const list = params.deltas;
    if (!Array.isArray(list)) continue;
    for (const delta of list) {
      if (isRecord(delta)) deltas.push(delta);
    }
  }
  return deltas;
}

function deltaKinds(
  messages: readonly BridgeJsonRpcOutputMessage[],
  threadId: string,
): string[] {
  const kinds: string[] = [];
  for (const message of messages) {
    if (message.method !== "thread/delta") continue;
    const params = message.params;
    if (!isRecord(params) || params.threadId !== threadId) continue;
    const deltas = params.deltas;
    if (!Array.isArray(deltas)) continue;
    for (const delta of deltas) {
      if (!isRecord(delta) || typeof delta.kind !== "string") continue;
      kinds.push(delta.kind);
    }
  }
  return kinds;
}

function interactionId(
  messages: readonly BridgeJsonRpcOutputMessage[],
): string | number | undefined {
  for (const message of messages) {
    if (message.method === "interaction/request" && message.id !== undefined) {
      return message.id;
    }
  }
  return undefined;
}

function errorFor(
  messages: readonly BridgeJsonRpcOutputMessage[],
  id: string | number,
): { code: number; message: string } | undefined {
  for (const message of messages) {
    if (message.id === id && message.error !== undefined) return message.error;
  }
  return undefined;
}

async function withGraceClock(
  run: (passGrace: () => Promise<void>) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  try {
    await run(async () => {
      await vi.advanceTimersByTimeAsync(UNOPENED_DISPATCH_GRACE_MS * 4);
    });
  } finally {
    vi.useRealTimers();
  }
}

function drainRejections(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for bridge output");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function providerThreadId(response: BridgeJsonRpcOutputMessage): string {
  const result = response.result;
  if (!isRecord(result) || typeof result.providerThreadId !== "string") {
    throw new Error("thread/start did not return a provider thread id");
  }
  return result.providerThreadId;
}

async function withBridge(
  hooks: {
    prompt?: (input: OpenCodePromptInput) => Promise<void>;
    compact?: () => Promise<void>;
    replyPermission?: () => Promise<void>;
    failContext?: boolean;
    injectResync?: boolean;
  },
  run: (tools: {
    request: (
      method: string,
      params: BridgeJsonRpcObject,
    ) => Promise<BridgeJsonRpcOutputMessage>;
    messages: BridgeJsonRpcOutputMessage[];
    emit: (event: Record<string, unknown>) => void;
    failStream: (error: unknown) => void;
    prompts: OpenCodePromptInput[];
    counts: { compacts: number };
    permissionReplies: Array<{ requestID: string; reply: string }>;
    permissionReplyAttempts: string[];
    cancelledForms: string[];
    setFailPermission: (value: boolean) => void;
    reply: (id: string | number, body: BridgeJsonRpcObject) => void;
  }) => Promise<void>,
): Promise<void> {
  const prompts: OpenCodePromptInput[] = [];
  const permissionReplies: Array<{ requestID: string; reply: string }> = [];
  const permissionReplyAttempts: string[] = [];
  const cancelledForms: string[] = [];
  const counts = { compacts: 0 };
  let failPermission = false;
  const inner = createFakeOpenCodeRuntime({ skills: SKILLS });
  const runtime: OpenCodeRuntime = {
    ...inner,
    createSession: async (input) => {
      const handle = await inner.createSession(input);
      return {
        ...handle,
        prompt: async (inputPrompt) => {
          prompts.push(inputPrompt);
          if (hooks.prompt !== undefined) {
            await hooks.prompt(inputPrompt);
            return;
          }
          await handle.prompt(inputPrompt);
        },
        compact: async () => {
          counts.compacts += 1;
          if (hooks.compact !== undefined) {
            await hooks.compact();
            return;
          }
          await handle.compact();
        },
        replyPermission: async (requestID, reply) => {
          permissionReplyAttempts.push(requestID);
          if (failPermission) throw new Error("permission reply failed");
          await hooks.replyPermission?.();
          permissionReplies.push({ requestID, reply });
          await handle.replyPermission(requestID, reply);
        },
        cancelForm: async (formID) => {
          cancelledForms.push(formID);
          await handle.cancelForm(formID);
        },
        context: async () => {
          if (hooks.failContext === true) throw new Error("context failed");
          return handle.context();
        },
      };
    },
    subscribe: (sessionID, signal) => {
      const events = inner.subscribe(sessionID, signal);
      if (hooks.injectResync !== true) return events;
      const resync: RuntimeSessionEvent = {
        kind: "resync",
        sessionID,
        reason: "reconnect",
      };
      return {
        [Symbol.asyncIterator]() {
          const iterator = events[Symbol.asyncIterator]();
          let primed = false;
          return {
            async next() {
              if (!primed) {
                primed = true;
                return { done: false, value: resync };
              }
              return iterator.next();
            },
            async return() {
              await iterator.return?.();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
  const bridge = createOpenCodeBridge({
    createRuntime: async () => runtime,
  });
  const rpc = createBridgeJsonRpcTestHarness(bridge.handleLine);
  let nextId = 0;
  try {
    await run({
      messages: rpc.messages,
      prompts,
      counts,
      permissionReplies,
      permissionReplyAttempts,
      cancelledForms,
      setFailPermission(value: boolean) {
        failPermission = value;
      },
      emit: (event) => inner.emit(event),
      failStream: (error) => inner.failStream(error),
      async request(method, params) {
        nextId += 1;
        const id = nextId;
        rpc.sendRequest(id, method, params);
        return rpc.waitForResponse(id);
      },
      reply(id, body) {
        bridge.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            ...body,
          }),
        );
      },
    });
  } finally {
    await bridge.closeAll();
    rpc.restore();
  }
}

async function startThread(
  request: (
    method: string,
    params: BridgeJsonRpcObject,
  ) => Promise<BridgeJsonRpcOutputMessage>,
  threadId: string,
): Promise<string> {
  const started = await request("thread/start", {
    threadId,
    cwd: CWD,
    instructionMode: "append",
    options: executionOptions(),
  });
  expect(started.error).toBeUndefined();
  return providerThreadId(started);
}

describe("OpenCode turn dispatch and interaction replies", () => {
  it("returns an error and emits nothing when prompt throws", async () => {
    await withGraceClock((passGrace) => withBridge(
      {
        prompt: async () => {
          throw new Error("prompt failed");
        },
      },
      async ({ request, messages, prompts }) => {
        const threadId = "thr_prompt_fail";
        const sessionId = await startThread(request, threadId);
        const before = deltaKinds(messages, threadId);
        const response = await request("turn/start", {
          threadId,
          providerThreadId: sessionId,
          clientRequestId: "creq_23456789ab",
          input: [{ type: "text", text: "hi", mentions: [] }],
          options: executionOptions(),
        });
        expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
        expect(response.error?.message).toBe("prompt failed");
        expect(prompts).toHaveLength(1);
        await passGrace();
        expect(deltaKinds(messages, threadId)).toEqual(before);
      },
    ));
  });

  it("rejects an unknown skill before dispatch", async () => {
    await withBridge({}, async ({ request, messages, prompts }) => {
      const threadId = "thr_skill";
      const sessionId = await startThread(request, threadId);
      const text = "/missing";
      const response = await request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_3456789abc",
        input: [
          {
            type: "text",
            text,
            mentions: [
              {
                start: 0,
                end: text.length,
                resource: {
                  kind: "command",
                  trigger: "/",
                  name: "missing",
                  source: "skill",
                  origin: "user",
                  label: "missing",
                  argumentHint: null,
                },
              },
            ],
          },
        ],
        options: executionOptions(),
      });
      expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
      expect(response.error?.message).toBe('Unknown OpenCode skill "missing"');
      expect(prompts).toEqual([]);
      expect(deltaKinds(messages, threadId)).not.toContain("input.accepted");
    });
  });

  it("settles a zero-work compact with an open, accept, and boundary", async () => {
    await withBridge(
      {
        compact: async () => undefined,
      },
      async ({ request, messages, counts }) => {
        const threadId = "thr_compact";
        const sessionId = await startThread(request, threadId);
        const response = await request("turn/start", {
          threadId,
          providerThreadId: sessionId,
          clientRequestId: "creq_456789abcd",
          input: [
            {
              type: "text",
              text: "/compact",
              mentions: [
                {
                  start: 0,
                  end: "/compact".length,
                  resource: {
                    kind: "command",
                    trigger: "/",
                    name: "compact",
                    source: "command",
                    origin: "builtin",
                    label: "compact",
                    argumentHint: null,
                  },
                },
              ],
            },
          ],
          options: executionOptions(),
        });
        expect(response.error).toBeUndefined();
        expect(counts.compacts).toBe(1);
        await waitFor(() =>
          deltaKinds(messages, threadId).includes("turn.boundary"),
        );
        expect(
          deltaKinds(messages, threadId).filter(
            (kind) =>
              kind === "turn.open" ||
              kind === "input.accepted" ||
              kind === "turn.boundary",
          ),
        ).toEqual(["turn.open", "input.accepted", "turn.boundary"]);
      },
    );
  });

  it("keeps a permission pending when the reply fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await withBridge({}, async (tools) => {
        const threadId = "thr_reply_fail";
        const sessionId = await startThread(tools.request, threadId);
        tools.emit({
          type: "permission.asked",
          data: {
            id: "per_1",
            sessionID: sessionId,
            action: "read",
            resources: ["hello.txt"],
          },
        });
        await waitFor(() => interactionId(tools.messages) !== undefined);
        const id = interactionId(tools.messages);
        if (id === undefined) throw new Error("missing interaction");
        tools.setFailPermission(true);
        tools.reply(id, {
          result: { decision: "allow_once", grantedPermissions: null },
        });
        await waitFor(() => deltaKinds(tools.messages, threadId).includes("provider.error"));
        expect(
          threadDeltas(tools.messages, threadId).find((delta) => delta.kind === "provider.error"),
        ).toMatchObject({ message: "permission reply failed", threadScoped: true });
        expect(tools.permissionReplies).toEqual([]);
        tools.setFailPermission(false);
        tools.reply(id, {
          result: { decision: "allow_once", grantedPermissions: null },
        });
        await waitFor(() => tools.permissionReplies.length === 1);
        expect(tools.permissionReplies).toEqual([{ requestID: "per_1", reply: "once" }]);
        await drainRejections();
        expect(unhandled).toEqual([]);
      });
      await drainRejections();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("denies a permission when the interaction response is an error", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_deny";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "permission.asked",
        data: {
          id: "per_2",
          sessionID: sessionId,
          action: "edit",
          resources: ["hello.txt"],
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      tools.reply(id, { error: { code: -32000, message: "dismissed" } });
      await waitFor(() => tools.permissionReplies.length === 1);
      expect(tools.permissionReplies).toEqual([
        { requestID: "per_2", reply: "reject" },
      ]);
    });
  });

  it("cancels a form when the interaction response is an error", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_form";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "form.created",
        data: {
          form: {
            id: "form_1",
            sessionID: sessionId,
            title: "Question",
            fields: [
              {
                key: "choice",
                title: "Pick",
                type: "string",
                required: true,
                options: [{ value: "red", label: "Red" }],
              },
            ],
          },
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      tools.reply(id, { error: { code: -32000, message: "dismissed" } });
      await waitFor(() => tools.cancelledForms.length === 1);
      expect(tools.cancelledForms).toEqual(["form_1"]);
    });
  });

  it("retains the pending entry when the resolution cannot be parsed", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_parse";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "permission.asked",
        data: {
          id: "per_3",
          sessionID: sessionId,
          action: "read",
          resources: ["hello.txt"],
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      tools.reply(id, { result: { nope: true } });
      await waitFor(() => errorFor(tools.messages, id) !== undefined);
      expect(errorFor(tools.messages, id)?.code).toBe(
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      );
      expect(tools.permissionReplies).toEqual([]);
      tools.reply(id, {
        result: { decision: "deny" },
      });
      await waitFor(() => tools.permissionReplies.length === 1);
      expect(tools.permissionReplies).toEqual([
        { requestID: "per_3", reply: "reject" },
      ]);
    });
  });

  it("retains the pending entry when the resolution kind does not match", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_kind";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "permission.asked",
        data: {
          id: "per_4",
          sessionID: sessionId,
          action: "read",
          resources: ["hello.txt"],
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      tools.reply(id, {
        result: {
          kind: "user_answer",
          answers: { choice: { selected: ["red"] } },
        },
      });
      await waitFor(() => errorFor(tools.messages, id) !== undefined);
      expect(errorFor(tools.messages, id)?.code).toBe(
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      );
      expect(tools.permissionReplies).toEqual([]);
      tools.reply(id, {
        result: { decision: "allow_once", grantedPermissions: null },
      });
      await waitFor(() => tools.permissionReplies.length === 1);
      expect(tools.permissionReplies[0]?.reply).toBe("once");
    });
  });

  it("drops pending interactions for a detached thread", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_detach";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "permission.asked",
        data: {
          id: "per_5",
          sessionID: sessionId,
          action: "read",
          resources: ["hello.txt"],
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      const discarded = await tools.request("thread/discard", {
        threadId,
        providerThreadId: sessionId,
      });
      expect(discarded.error).toBeUndefined();
      tools.reply(id, {
        result: { decision: "allow_once", grantedPermissions: null },
      });
      expect(tools.permissionReplyAttempts).toEqual([]);
      expect(tools.permissionReplies).toEqual([]);
    });
  });

  it("does not settle a prompt as zero-work when execution starts after the grace", async () => {
    await withGraceClock((passGrace) => withBridge({ prompt: async () => undefined }, async ({ request, messages, emit }) => {
      const threadId = "thr_prompt_live";
      const sessionId = await startThread(request, threadId);
      const response = await request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_56789abcde",
        input: [{ type: "text", text: "hi", mentions: [] }],
        options: executionOptions(),
      });
      expect(response.error).toBeUndefined();
      await passGrace();
      expect(deltaKinds(messages, threadId)).not.toContain("turn.boundary");
      expect(deltaKinds(messages, threadId)).not.toContain("turn.open");
      emit({
        type: "session.execution.started",
        data: { sessionID: sessionId },
      });
      await waitFor(() => deltaKinds(messages, threadId).includes("turn.open"));
      const deltas = threadDeltas(messages, threadId);
      const opens = deltas.filter((delta) => delta.kind === "turn.open");
      expect(opens).toHaveLength(1);
      expect(opens[0]?.providerTurnId).toBe(`exec:${sessionId}:0`);
      expect(deltas.filter((delta) => delta.kind === "input.accepted")).toEqual([
        {
          kind: "input.accepted",
          clientRequestId: "creq_56789abcde",
          providerTurnId: `exec:${sessionId}:0`,
        },
      ]);
      expect(deltaKinds(messages, threadId)).not.toContain("turn.boundary");
    }));
  });

  it("stamps input.accepted with the live provider turn id", async () => {
    await withBridge({}, async ({ request, messages, emit }) => {
      const threadId = "thr_stamp";
      const sessionId = await startThread(request, threadId);
      emit({
        type: "session.execution.started",
        data: { sessionID: sessionId },
      });
      await waitFor(() => deltaKinds(messages, threadId).includes("turn.open"));
      const response = await request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_6789abcdef",
        input: [{ type: "text", text: "again", mentions: [] }],
        options: executionOptions(),
      });
      expect(response.error).toBeUndefined();
      await waitFor(() => deltaKinds(messages, threadId).includes("input.accepted"));
      const deltas = threadDeltas(messages, threadId);
      expect(deltas.find((delta) => delta.kind === "input.accepted")).toEqual({
        kind: "input.accepted",
        clientRequestId: "creq_6789abcdef",
        providerTurnId: `exec:${sessionId}:0`,
      });
    });
  });

  it("keeps every unopened dispatch until one turn starts", async () => {
    await withBridge({}, async ({ request, messages, emit }) => {
      const threadId = "thr_two";
      const sessionId = await startThread(request, threadId);
      const first = await request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_789abcdef2",
        input: [{ type: "text", text: "one", mentions: [] }],
        options: executionOptions(),
      });
      const second = await request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_89abcdef23",
        input: [{ type: "text", text: "two", mentions: [] }],
        options: executionOptions(),
      });
      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
      emit({
        type: "session.execution.started",
        data: { sessionID: sessionId },
      });
      await waitFor(
        () =>
          threadDeltas(messages, threadId).filter((delta) => delta.kind === "input.accepted")
            .length === 2,
      );
      const deltas = threadDeltas(messages, threadId);
      expect(deltas.filter((delta) => delta.kind === "turn.open")).toEqual([
        { kind: "turn.open", providerTurnId: `exec:${sessionId}:0` },
      ]);
      expect(deltas.filter((delta) => delta.kind === "input.accepted")).toEqual([
        {
          kind: "input.accepted",
          clientRequestId: "creq_789abcdef2",
          providerTurnId: `exec:${sessionId}:0`,
        },
        {
          kind: "input.accepted",
          clientRequestId: "creq_89abcdef23",
          providerTurnId: `exec:${sessionId}:0`,
        },
      ]);
    });
  });

  it("fails an open turn when the event stream rejects", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_stream";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "session.execution.started",
        data: { sessionID: sessionId },
      });
      await waitFor(() => deltaKinds(tools.messages, threadId).includes("turn.open"));
      tools.failStream(new Error("event stream failed"));
      await waitFor(() => deltaKinds(tools.messages, threadId).includes("turn.boundary"));
      const deltas = threadDeltas(tools.messages, threadId);
      expect(deltas.find((delta) => delta.kind === "provider.error")).toMatchObject({
        kind: "provider.error",
        message: "event stream failed",
        providerTurnId: `exec:${sessionId}:0`,
      });
      expect(deltas.find((delta) => delta.kind === "turn.boundary")).toMatchObject({
        kind: "turn.boundary",
        status: "failed",
        providerTurnId: `exec:${sessionId}:0`,
      });
    });
  });

  it("emits provider.error when a runtime event cannot be applied", async () => {
    await withBridge({ failContext: true, injectResync: true }, async (tools) => {
      const threadId = "thr_apply";
      const sessionId = await startThread(tools.request, threadId);
      await waitFor(() => deltaKinds(tools.messages, threadId).includes("provider.error"));
      expect(threadDeltas(tools.messages, threadId).find((delta) => delta.kind === "provider.error")).toMatchObject({
        kind: "provider.error",
        message: "context failed",
      });
      tools.emit({
        type: "permission.asked",
        data: {
          id: "per_apply",
          sessionID: sessionId,
          action: "read",
          resources: ["hello.txt"],
        },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
    });
  });

  it("stamps input.accepted with a turn that opened and closed during dispatch", async () => {
    let finishTurn: () => Promise<void> = async () => undefined;
    await withGraceClock((passGrace) => withBridge(
      { prompt: () => finishTurn(), compact: () => finishTurn() },
      async (tools) => {
        const threadId = "thr_fast_turn";
        const sessionId = await startThread(tools.request, threadId);
        let played = 0;
        finishTurn = async () => {
          const before = played;
          played += 1;
          tools.emit({
            type: "session.execution.started",
            data: { sessionID: sessionId },
            durable: { aggregateID: sessionId, seq: before * 2 + 1 },
          });
          tools.emit({
            type: "session.execution.succeeded",
            data: { sessionID: sessionId },
            durable: { aggregateID: sessionId, seq: before * 2 + 2 },
          });
          await waitFor(
            () =>
              deltaKinds(tools.messages, threadId).filter((kind) => kind === "turn.boundary")
                .length === played,
          );
        };
        const prompt = await tools.request("turn/start", {
          threadId,
          providerThreadId: sessionId,
          clientRequestId: "creq_fast234567",
          input: [{ type: "text", text: "quick", mentions: [] }],
          options: executionOptions(),
        });
        expect(prompt.error).toBeUndefined();
        const compact = await tools.request("turn/start", {
          threadId,
          providerThreadId: sessionId,
          clientRequestId: "creq_fast345678",
          input: [
            {
              type: "text",
              text: "/compact",
              mentions: [
                {
                  start: 0,
                  end: 8,
                  resource: {
                    kind: "command",
                    trigger: "/",
                    name: "compact",
                    source: "command",
                    origin: "builtin",
                    label: "compact",
                    argumentHint: null,
                  },
                },
              ],
            },
          ],
          options: executionOptions(),
        });
        expect(compact.error).toBeUndefined();
        await passGrace();
        const deltas = threadDeltas(tools.messages, threadId);
        const opens = deltas.filter((delta) => delta.kind === "turn.open");
        expect(opens.map((delta) => delta.providerTurnId)).toEqual([
          `exec:${sessionId}:1`,
          `exec:${sessionId}:3`,
        ]);
        expect(
          deltas
            .filter((delta) => delta.kind === "input.accepted")
            .map((delta) => [delta.clientRequestId, delta.providerTurnId]),
        ).toEqual([
          ["creq_fast234567", `exec:${sessionId}:1`],
          ["creq_fast345678", `exec:${sessionId}:3`],
        ]);
      },
    ));
  });

  it("detaches the session after the event stream fails", async () => {
    await withBridge({}, async (tools) => {
      const threadId = "thr_stream_detach";
      const sessionId = await startThread(tools.request, threadId);
      tools.failStream(new Error("event stream failed"));
      await waitFor(() => deltaKinds(tools.messages, threadId).includes("provider.error"));
      const response = await tools.request("turn/start", {
        threadId,
        providerThreadId: sessionId,
        clientRequestId: "creq_deaf234567",
        input: [{ type: "text", text: "hello?", mentions: [] }],
        options: executionOptions(),
      });
      expect(response.error).toMatchObject({
        code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        message: "No active OpenCode session",
      });
      expect(tools.prompts).toEqual([]);
    });
  });

  it("replies once when an interaction response arrives twice", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withBridge({ replyPermission: () => held }, async (tools) => {
      const threadId = "thr_dup_reply";
      const sessionId = await startThread(tools.request, threadId);
      tools.emit({
        type: "permission.asked",
        data: { id: "per_dup", sessionID: sessionId, action: "read", resources: ["a"] },
      });
      await waitFor(() => interactionId(tools.messages) !== undefined);
      const id = interactionId(tools.messages);
      if (id === undefined) throw new Error("missing interaction");
      const answer = { result: { decision: "allow_once", grantedPermissions: null } };
      tools.reply(id, answer);
      tools.reply(id, answer);
      expect(tools.permissionReplyAttempts).toEqual(["per_dup"]);
      release();
      await waitFor(() => tools.permissionReplies.length === 1);
      expect(tools.permissionReplyAttempts).toEqual(["per_dup"]);
      expect(tools.permissionReplies).toEqual([{ requestID: "per_dup", reply: "once" }]);
    });
  });
});
