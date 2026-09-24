import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { toOpenCodeModel } from "../models.js";
import {
  createFakeOpenCodeRuntime,
  type OpenCodeRuntime,
  type RuntimeSessionEvent,
  type SessionHandle,
} from "../runtime/index.js";
import {
  FULL_PERMISSION_OPTIONS,
  type OpenCodeBridgeHarness,
  type StartOpenCodeBridgeHarnessOptions,
  startOpenCodeBridgeHarness,
} from "./test-support.js";

let harness: OpenCodeBridgeHarness;

beforeEach(async () => {
  harness = await startOpenCodeBridgeHarness({
    prefix: "bb-opencode-bridge-methods-",
    scriptTurns: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("shares overlapping attachment probes and retries after a failed probe", async () => {
  let probes = 0;
  let rejectProbe: (error: Error) => void = () => undefined;
  const held = new Promise<never>((_resolve, reject) => {
    rejectProbe = reject;
  });
  await useHarness({
    wrapRuntime: (fake) => ({
      ...fake,
      health: async () => {
        probes += 1;
        if (probes === 1) return held;
        return fake.health();
      },
    }),
  });
  const first = harness.request(101, "model/list", {
    cwd: harness.workspaceDir,
  });
  const second = harness.request(102, "model/list", {
    cwd: harness.workspaceDir,
  });
  await harness.waitFor(() => probes > 0, "attachment probe");
  expect(probes).toBe(1);
  rejectProbe(new Error("discovery unavailable"));
  const failed = await Promise.all([first, second]);
  expect(failed.every((response) => response.error !== undefined)).toBe(true);
  const retry = await harness.request(103, "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(retry.error).toBeUndefined();
  expect(probes).toBe(2);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerThreadId(response: BridgeJsonRpcOutputMessage): string {
  const result = response.result;
  if (!isRecord(result) || typeof result.providerThreadId !== "string") {
    throw new Error("missing providerThreadId");
  }
  return result.providerThreadId;
}

async function openTurn(
  threadId: string,
  text: string,
  clientRequestId: string,
): Promise<{ sessionId: string }> {
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const response = await harness.request(clientRequestId, "turn/start", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId,
    input: [{ type: "text", text, mentions: [] }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(response.error).toBeUndefined();
  return { sessionId };
}

function deltaKinds(threadId: string): string[] {
  return harness.deltasOf(threadId).flatMap((delta) =>
    typeof delta.kind === "string" ? [delta.kind] : [],
  );
}

function interactionRequest(): BridgeJsonRpcOutputMessage | undefined {
  return harness.rpc.messages.find(
    (message) => message.method === "interaction/request" && message.id !== undefined,
  );
}

it("turn/start accepts a prompt and settles the turn", async () => {
  const threadId = "thr_start";
  const { sessionId } = await openTurn(threadId, "say hello", "creq_23456789ab");
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.boundary"),
    "turn/start boundary",
  );
  expect(harness.fake.calls.prompts.map((prompt) => prompt.text)).toEqual([
    "say hello",
  ]);
  expect(harness.fake.calls.prompts[0]?.delivery).toBe("steer");
  const boundary = harness.deltasOf(threadId).find((delta) => delta.kind === "turn.boundary");
  expect(boundary).toMatchObject({ kind: "turn.boundary", status: "completed" });
  expect(sessionId.length).toBeGreaterThan(0);
});

it("turn/steer injects into the open turn", async () => {
  const threadId = "thr_steer";
  const { sessionId } = await openTurn(threadId, "/hold", "creq_3456789abc");
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.open"),
    "held turn",
  );
  const open = harness.deltasOf(threadId).find((delta) => delta.kind === "turn.open");
  if (open === undefined || typeof open.providerTurnId !== "string") {
    throw new Error("held turn has no provider turn id");
  }
  const response = await harness.request("creq_456789abcd", "turn/steer", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId: "creq_456789abcd",
    expectedTurnId: open.providerTurnId,
    input: [{ type: "text", text: "steer this", mentions: [] }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(response.error).toBeUndefined();
  expect(harness.fake.calls.prompts.map((prompt) => prompt.delivery)).toEqual([
    "steer",
    "steer",
  ]);
  expect(harness.fake.calls.prompts[1]?.text).toBe("steer this");
});

it("thread/stop releases without an interrupt and interrupt settles the turn", async () => {
  const releaseThread = "thr_release";
  const { sessionId: releaseSession } = await openTurn(
    releaseThread,
    "done",
    "creq_56789abcde",
  );
  await harness.waitFor(
    () => deltaKinds(releaseThread).includes("turn.boundary"),
    "release turn",
  );
  const before = harness.deltasOf(releaseThread).length;
  const released = await harness.request(41, "thread/stop", {
    threadId: releaseThread,
    providerThreadId: releaseSession,
    intent: "release",
    activeTurnId: null,
  });
  expect(released.error).toBeUndefined();
  expect(released.result).toMatchObject({ ok: true });
  expect(
    harness
      .deltasOf(releaseThread)
      .slice(before)
      .some((delta) => delta.status === "interrupted"),
  ).toBe(false);

  const interruptThread = "thr_interrupt";
  const { sessionId } = await openTurn(interruptThread, "/hold", "creq_6789abcdef");
  await harness.waitFor(
    () => deltaKinds(interruptThread).includes("turn.open"),
    "interruptible turn",
  );
  const stopped = await harness.request(42, "thread/stop", {
    threadId: interruptThread,
    providerThreadId: sessionId,
    intent: "interrupt",
    activeTurnId: null,
  });
  expect(stopped.error).toBeUndefined();
  expect(harness.fake.calls.interrupts).toBe(1);
  expect(
    harness.deltasOf(interruptThread).some(
      (delta) => delta.kind === "turn.boundary" && delta.status === "interrupted",
    ),
  ).toBe(true);
});

it("thread/discard detaches the session", async () => {
  const threadId = "thr_discard";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const discarded = await harness.request(51, "thread/discard", {
    threadId,
    providerThreadId: sessionId,
  });
  expect(discarded.error).toBeUndefined();
  expect(discarded.result).toMatchObject({ ok: true });
  const again = await harness.request(52, "turn/start", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId: "creq_789abcdef2",
    input: [{ type: "text", text: "after discard", mentions: [] }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(again.error).toMatchObject({ message: "No active OpenCode session" });
});

it("thread/name/set renames the session", async () => {
  const threadId = "thr_name";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const renamed = await harness.request(61, "thread/name/set", {
    threadId,
    providerThreadId: sessionId,
    title: "Renamed thread",
  });
  expect(renamed.error).toBeUndefined();
  expect(renamed.result).toMatchObject({ ok: true });
  expect(harness.fake.calls.titles).toEqual(["Renamed thread"]);
  expect(harness.deltasOf(threadId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "thread.name", name: "Renamed thread" }),
    ]),
  );
  const info = await (await harness.fake.openSession(sessionId)).info();
  expect(info.title).toBe("Renamed thread");
});

it("compaction runs and reaches a boundary", async () => {
  const threadId = "thr_compact";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const text = "/compact";
  const response = await harness.request("creq_89abcdef23", "turn/start", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId: "creq_89abcdef23",
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
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(response.error).toBeUndefined();
  expect(harness.fake.calls.compacts).toBe(1);
  await harness.fake.play({
    type: "session.compaction.ended",
    data: { sessionID: sessionId, reason: "manual", text: "summary" },
  });
  await harness.rpc.flushWork();
  await harness.waitFor(
    () => deltaKinds(threadId).includes("context.compacted"),
    "compaction ended",
  );
  expect(deltaKinds(threadId)).not.toContain("turn.boundary");
  await harness.fake.play({
    type: "session.execution.succeeded",
    data: { sessionID: sessionId },
  });
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.boundary"),
    "compaction boundary",
  );
  const kinds = deltaKinds(threadId);
  expect(kinds.filter((kind) => kind === "turn.open")).toHaveLength(1);
  expect(kinds.filter((kind) => kind === "turn.boundary")).toHaveLength(1);
  expect(kinds.indexOf("context.compacted")).toBeLessThan(kinds.indexOf("turn.boundary"));
  expect(kinds).toContain("input.accepted");
});

it("thread/fork returns a new session", async () => {
  const threadId = "thr_fork_source";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sourceId = providerThreadId(started);
  const forked = await harness.request(71, "thread/fork", {
    threadId: "thr_fork_child",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: sourceId,
    instructionMode: "append",
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(forked.error).toBeUndefined();
  const childId = providerThreadId(forked);
  expect(childId).not.toBe(sourceId);
  expect(harness.fake.calls.forks).toBe(1);
  expect(
    harness.rpc.messages.some((message) => {
      if (message.method !== "thread/identity" || !isRecord(message.params)) return false;
      return message.params.threadId === "thr_fork_child" && message.params.providerThreadId === childId;
    }),
  ).toBe(true);
});

it("permission reply reaches OpenCode", async () => {
  const threadId = "thr_permission";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  harness.fake.emit({
    type: "permission.asked",
    data: {
      id: "per_1",
      sessionID: sessionId,
      action: "read",
      resources: ["hello.txt"],
    },
  });
  await harness.waitFor(() => interactionRequest() !== undefined, "permission request");
  const request = interactionRequest();
  if (request?.id === undefined) throw new Error("missing permission interaction");
  harness.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { decision: "allow_once", grantedPermissions: null },
    }),
  );
  await harness.waitFor(
    () => harness.fake.calls.permissionReplies.length === 1,
    "permission reply",
  );
  expect(harness.fake.calls.permissionReplies).toEqual([
    { requestID: "per_1", reply: "once" },
  ]);
});

it("form reply reaches OpenCode", async () => {
  const threadId = "thr_form";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  harness.fake.emit({
    type: "form.created",
    data: {
      form: {
        id: "FORM_1",
        sessionID: sessionId,
        title: "m0 spike question",
        fields: [
          {
            key: "choice",
            title: "Pick a color",
            required: true,
            type: "string",
            options: [
              { value: "red", label: "Red" },
              { value: "blue", label: "Blue" },
            ],
          },
        ],
      },
    },
  });
  await harness.waitFor(() => interactionRequest() !== undefined, "form request");
  const request = interactionRequest();
  if (request?.id === undefined) throw new Error("missing form interaction");
  const result: BridgeJsonRpcObject = {
    kind: "user_answer",
    answers: { choice: { selected: ["blue"] } },
  };
  harness.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result,
    }),
  );
  await harness.waitFor(() => harness.fake.calls.formReplies.length === 1, "form reply");
  expect(harness.fake.calls.formReplies).toEqual([
    { formID: "FORM_1", answer: { choice: "blue" } },
  ]);
});

it("accepts a steer into a turn a child session opened before execution", async () => {
  const threadId = "thr_child_steer";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const child = await harness.fake.createSession({
    location: { directory: harness.workspaceDir },
  });
  await harness.fake.play({
    type: "session.created",
    data: { sessionID: child.id, parentID: sessionId, title: "helper" },
  });
  await harness.fake.play({
    type: "session.execution.started",
    data: { sessionID: sessionId },
  });
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.open"),
    "child-opened turn",
  );
  const opens = harness
    .deltasOf(threadId)
    .filter((delta) => delta.kind === "turn.open" && delta.parentRef === undefined);
  expect(opens).toHaveLength(1);
  const open = opens[0];
  if (open === undefined || typeof open.providerTurnId !== "string") {
    throw new Error("child-opened turn has no provider turn id");
  }
  const response = await harness.request("creq_9abcdef234", "turn/steer", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId: "creq_9abcdef234",
    expectedTurnId: open.providerTurnId,
    input: [{ type: "text", text: "steer this", mentions: [] }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  expect(response.error).toBeUndefined();
  expect(harness.fake.calls.prompts.map((prompt) => prompt.text)).toEqual(["steer this"]);
});

it("pages a form that does not fit one question and replies once", async () => {
  const threadId = "thr_form_pages";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  harness.fake.emit({
    type: "form.created",
    data: {
      form: {
        id: "FORM_2",
        sessionID: sessionId,
        title: "Setup",
        fields: [
          { key: "a", type: "string", required: true },
          { key: "b", type: "number" },
          { key: "c", type: "boolean" },
          { key: "d", type: "string" },
          { key: "e", type: "string", required: true },
        ],
      },
    },
  });
  const requests = () =>
    harness.rpc.messages.filter(
      (message) => message.method === "interaction/request" && message.id !== undefined,
    );
  await harness.waitFor(() => requests().length === 1, "first form page");
  const first = requests()[0];
  if (first?.id === undefined) throw new Error("missing first form page");
  harness.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: first.id,
      result: {
        kind: "user_answer",
        answers: {
          a: { selected: [], freeText: "alpha" },
          b: { selected: [], freeText: "2.5" },
          c: { selected: ["false"] },
        },
      },
    }),
  );
  await harness.waitFor(() => requests().length === 2, "second form page");
  expect(harness.fake.calls.formReplies).toEqual([]);
  const second = requests()[1];
  if (second?.id === undefined || !isRecord(second.params)) {
    throw new Error("missing second form page");
  }
  expect(second.params.payload).toMatchObject({
    kind: "user_question",
    questions: [{ id: "e" }],
  });
  harness.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: second.id,
      result: { kind: "user_answer", answers: { e: { selected: [], freeText: "echo" } } },
    }),
  );
  await harness.waitFor(() => harness.fake.calls.formReplies.length === 1, "form reply");
  expect(harness.fake.calls.formReplies).toEqual([
    { formID: "FORM_2", answer: { a: "alpha", b: 2.5, c: false, e: "echo" } },
  ]);
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function useHarness(
  options: StartOpenCodeBridgeHarnessOptions,
): Promise<OpenCodeBridgeHarness> {
  await harness.teardown();
  harness = await startOpenCodeBridgeHarness({
    prefix: "bb-opencode-bridge-methods-",
    ...options,
  });
  return harness;
}

function keepOpenAcrossBridges(fake: OpenCodeRuntime): OpenCodeRuntime {
  return { ...fake, close: async () => undefined };
}

function paramsOf(message: BridgeJsonRpcOutputMessage): Record<string, unknown> {
  return isRecord(message.params) ? message.params : {};
}

function messageIndex(
  predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
): number {
  return harness.rpc.messages.findIndex(predicate);
}

function deltaMessageIndex(
  threadId: string,
  predicate: (delta: Record<string, unknown>) => boolean,
): number {
  return messageIndex((message) => {
    if (message.method !== "thread/delta") return false;
    const params = paramsOf(message);
    if (params.threadId !== threadId || !Array.isArray(params.deltas)) return false;
    return params.deltas.some((delta: unknown) => isRecord(delta) && predicate(delta));
  });
}

function turnInput(
  threadId: string,
  sessionId: string,
  clientRequestId: string,
  text: string,
  options: BridgeJsonRpcObject = FULL_PERMISSION_OPTIONS,
): BridgeJsonRpcObject {
  return {
    threadId,
    providerThreadId: sessionId,
    clientRequestId,
    input: [{ type: "text", text, mentions: [] }],
    options,
  };
}

function errorData(response: BridgeJsonRpcOutputMessage): Record<string, unknown> {
  const error: unknown = response.error;
  if (!isRecord(error) || !isRecord(error.data)) return {};
  return error.data;
}

it("thread/fork refuses a source that is not bb-owned or is bound to another cwd", async () => {
  const foreign = await harness.fake.createSession({
    location: { directory: harness.workspaceDir },
  });
  const rejected = await harness.request(81, "thread/fork", {
    threadId: "thr_fork_foreign",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: foreign.id,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(rejected.error?.message).toContain("not a bb-owned session");
  const started = await harness.startThread("thr_fork_owned");
  const moved = await harness.request(82, "thread/fork", {
    threadId: "thr_fork_moved",
    cwd: join(harness.workspaceDir, "elsewhere"),
    sourceProviderThreadId: providerThreadId(started),
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(moved.error?.message).toContain("is bound to");
  expect(harness.fake.calls.forks).toBe(0);
});

it("thread/fork warns about dropped tools and persists the fork's owner", async () => {
  const dataDir = tempDir("bb-opencode-owners-");
  const fake = createFakeOpenCodeRuntime({ scriptTurns: true });
  await useHarness({ fake, dataDir, wrapRuntime: keepOpenAcrossBridges });
  const cwd = harness.workspaceDir;
  const started = await harness.startThread("thr_fork_src");
  const forked = await harness.request(83, "thread/fork", {
    threadId: "thr_fork_dst",
    cwd,
    sourceProviderThreadId: providerThreadId(started),
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
    dynamicTools: [{ name: "bb_lookup", description: "lookup", inputSchema: {} }],
  });
  expect(forked.error).toBeUndefined();
  const forkId = providerThreadId(forked);
  expect(harness.deltasOf("thr_fork_dst")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "provider.warning",
        details: expect.stringContaining("Dropped dynamicTools: bb_lookup"),
      }),
    ]),
  );
  await harness.closeAll();
  await useHarness({ fake, dataDir, wrapRuntime: keepOpenAcrossBridges });
  const resumed = await harness.request(84, "thread/resume", {
    threadId: "thr_fork_dst",
    cwd,
    providerThreadId: forkId,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(resumed.error).toBeUndefined();
  expect(providerThreadId(resumed)).toBe(forkId);
});

it("settles the open turn and announces session/replaced before the new identity", async () => {
  const threadId = "thr_replace";
  const { sessionId } = await openTurn(threadId, "/hold", "creq_rep2345678");
  await harness.waitFor(() => deltaKinds(threadId).includes("turn.open"), "held turn");
  const again = await harness.startThread(threadId);
  expect(again.error).toBeUndefined();
  const nextId = providerThreadId(again);
  expect(nextId).not.toBe(sessionId);
  expect(harness.fake.calls.interruptedSessions).toContain(sessionId);
  const settledAt = deltaMessageIndex(
    threadId,
    (delta) => delta.kind === "turn.boundary" && delta.status === "interrupted",
  );
  const replacedAt = messageIndex((message) => message.method === "session/replaced");
  const identityAt = messageIndex(
    (message) =>
      message.method === "thread/identity" && paramsOf(message).providerThreadId === nextId,
  );
  expect(settledAt).toBeGreaterThanOrEqual(0);
  expect(replacedAt).toBeGreaterThan(settledAt);
  expect(identityAt).toBeGreaterThan(replacedAt);
  const replaced = harness.rpc.messages[replacedAt];
  if (replaced === undefined) throw new Error("missing session/replaced");
  expect(paramsOf(replaced)).toMatchObject({
    threadId,
    providerThreadId: nextId,
    contextLost: true,
  });
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.boundary")).toHaveLength(1);
});

it("reports a failed execution's reason and asks for sign-in on a 401", async () => {
  const threadId = "thr_failed";
  const started = await harness.startThread(threadId);
  const sessionId = providerThreadId(started);
  await harness.fake.play({
    type: "session.execution.started",
    data: { sessionID: sessionId },
  });
  await harness.fake.play({
    type: "session.execution.failed",
    data: {
      sessionID: sessionId,
      error: { type: "ProviderAuthError", message: "API key rejected", status: 401 },
    },
  });
  await harness.waitFor(() => deltaKinds(threadId).includes("turn.boundary"), "failed turn");
  const deltas = harness.deltasOf(threadId);
  const errorAt = deltas.findIndex((delta) => delta.kind === "provider.error");
  const boundaryAt = deltas.findIndex((delta) => delta.kind === "turn.boundary");
  expect(deltas[errorAt]).toMatchObject({
    message: "API key rejected",
    detail: "ProviderAuthError",
    errorInfo: { category: "unauthorized", httpStatusCode: 401 },
  });
  expect(errorAt).toBeLessThan(boundaryAt);
  expect(deltas[boundaryAt]).toMatchObject({
    status: "failed",
    error: { message: "API key rejected" },
  });
  expect(
    harness.rpc.messages.filter((message) => message.method === "provider/recovery").map(paramsOf),
  ).toEqual([
    expect.objectContaining({ threadId, kind: "authRequired", retryable: false }),
  ]);
});

it("rejects thread/start with a typed authRequired error when OpenCode is signed out", async () => {
  await useHarness({
    runtime: {
      health: {
        status: "unauthenticated",
        statusMessage: "OpenCode rejected the saved credentials",
        appId: "opencode",
        version: "2.0.10",
        installedVersion: "2.0.10",
        url: "http://127.0.0.1:9",
        registrationFile: null,
        pid: 1,
        pathBinaryAppId: "opencode",
      },
    },
  });
  const started = await harness.startThread("thr_signed_out");
  expect(started.error?.message).toContain("OpenCode rejected the saved credentials");
  expect(errorData(started)).toMatchObject({
    recovery: { kind: "authRequired", retryable: false },
  });
});

it("persists owners atomically and forgets them on thread/discard", async () => {
  const dataDir = tempDir("bb-opencode-owners-");
  await useHarness({ dataDir });
  const ownersFile = join(dataDir, "opencode-session-owners.json");
  const readOwners = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(ownersFile, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const started = await harness.startThread("thr_owned");
  const sessionId = providerThreadId(started);
  await harness.waitFor(() => sessionId in readOwners(), "owner write");
  expect(readOwners()[sessionId]).toEqual({
    threadId: "thr_owned",
    cwd: harness.workspaceDir,
  });
  const discarded = await harness.request(91, "thread/discard", {
    threadId: "thr_owned",
    providerThreadId: sessionId,
  });
  expect(discarded.error).toBeUndefined();
  await harness.waitFor(() => !(sessionId in readOwners()), "owner removal");
  expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("keeps thread/start working when the owners file cannot be written", async () => {
  const parent = tempDir("bb-opencode-owners-");
  const blocked = join(parent, "not-a-dir");
  writeFileSync(blocked, "file", "utf8");
  await useHarness({ dataDir: blocked });
  const started = await harness.startThread("thr_unwritable");
  expect(started.error).toBeUndefined();
  await harness.waitFor(
    () => harness.warnings.some((warning) => warning.includes("could not persist")),
    "persist warning",
  );
});

it("interrupts busy child sessions when the thread is released", async () => {
  const threadId = "thr_child_release";
  const started = await harness.startThread(threadId);
  const sessionId = providerThreadId(started);
  const child = await harness.fake.createSession({
    location: { directory: harness.workspaceDir },
  });
  await harness.fake.play({
    type: "session.created",
    data: { sessionID: child.id, parentID: sessionId, title: "helper" },
  });
  await harness.fake.play({
    type: "session.execution.started",
    data: { sessionID: child.id, parentID: sessionId },
  });
  await harness.waitFor(
    () =>
      harness
        .deltasOf(threadId)
        .some((delta) => delta.kind === "turn.open" && delta.parentRef === child.id),
    "child turn",
  );
  const released = await harness.request(92, "thread/stop", {
    threadId,
    providerThreadId: sessionId,
    intent: "release",
    activeTurnId: null,
  });
  expect(released.error).toBeUndefined();
  expect(harness.fake.calls.interruptedSessions).toEqual([child.id]);
});

it("denies disallowedTools through OpenCode permission rules on every update", async () => {
  const threadId = "thr_disallowed";
  const started = await harness.startThread(threadId, { disallowedTools: ["webfetch"] });
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  const deny = { action: "webfetch", resource: "*", effect: "deny" };
  const forSession = () =>
    harness.fake.calls.permissions.filter((entry) => entry.sessionID === sessionId);
  expect(forSession()[0]?.rules.at(-1)).toEqual(deny);
  const before = forSession().length;
  const turn = await harness.request(
    "creq_dis2345678",
    "turn/start",
    turnInput(threadId, sessionId, "creq_dis2345678", "hello"),
  );
  expect(turn.error).toBeUndefined();
  expect(forSession().length).toBeGreaterThan(before);
  expect(forSession().at(-1)?.rules.at(-1)).toEqual(deny);
});

it("refuses thread/start input and installation updates instead of ignoring them", async () => {
  const withInput = await harness.startThread("thr_with_input", {
    input: [{ type: "text", text: "hi", mentions: [] }],
  });
  expect(withInput.error).toMatchObject({ code: -32602 });
  expect(harness.fake.calls.prompts).toEqual([]);
  const update = await harness.request(93, "provider/installation/run", {
    providerId: "opencode",
    action: "update",
  });
  expect(update.error).toMatchObject({ code: -32602 });
});

it("freezes instructions for the session and clears them on reconstruction", async () => {
  const threadId = "thr_instructions";
  const started = await harness.startThread(threadId, {
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "be brief" },
  });
  const sessionId = providerThreadId(started);
  const writes = () =>
    harness.fake.calls.instructions.filter((entry) => entry.sessionID === sessionId);
  expect(writes()).toEqual([{ sessionID: sessionId, text: "be brief" }]);
  const turn = await harness.request(
    "creq_ins2345678",
    "turn/start",
    turnInput(threadId, sessionId, "creq_ins2345678", "hello", {
      ...FULL_PERMISSION_OPTIONS,
      instructions: "be verbose",
    }),
  );
  expect(turn.error).toBeUndefined();
  expect(writes()).toHaveLength(1);
  const resumed = await harness.request(94, "thread/resume", {
    threadId,
    cwd: harness.workspaceDir,
    providerThreadId: sessionId,
    instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "   " },
  });
  expect(resumed.error).toBeUndefined();
  expect(writes().at(-1)).toEqual({ sessionID: sessionId, text: "" });
});

it("model/list keeps the runtime's default model", async () => {
  await useHarness({
    runtime: {
      models: [
        toOpenCodeModel({ providerID: "anthropic", id: "sonnet", name: "Sonnet" }),
        toOpenCodeModel({
          providerID: "openai",
          id: "gpt",
          name: "GPT",
          isDefault: true,
          variants: [{ id: "low" }, { id: "high" }],
          defaultVariant: "high",
        }),
      ],
    },
  });
  const listed = await harness.request(95, "model/list", { cwd: harness.workspaceDir });
  const result = listed.result;
  if (!isRecord(result) || !Array.isArray(result.models)) {
    throw new Error("model/list returned no models");
  }
  expect(
    result.models.map((model: unknown) =>
      isRecord(model) ? [model.id, model.isDefault, model.defaultReasoningEffort] : null,
    ),
  ).toEqual([
    ["anthropic/sonnet", false, "none"],
    ["openai/gpt", true, "high"],
  ]);
});

it("model/list without a cwd lists models for the home directory, not the bridge cwd", async () => {
  const fake = createFakeOpenCodeRuntime({
    models: [toOpenCodeModel({ providerID: "openai", id: "gpt", name: "GPT", isDefault: true })],
  });
  const directories: string[] = [];
  const listModels = fake.models.bind(fake);
  fake.models = async (location) => {
    directories.push(location.directory);
    return listModels(location);
  };
  await useHarness({ fake });
  const listed = await harness.request(96, "model/list", {});
  expect(listed.error).toBeUndefined();
  expect(directories).toEqual([homedir()]);
});

it("thread/stop uses activeTurnId to interrupt dispatched work and skip stale turns", async () => {
  await useHarness({});
  const staleThread = "thr_stop_stale";
  const stale = await harness.startThread(staleThread);
  const stopped = await harness.request(96, "thread/stop", {
    threadId: staleThread,
    providerThreadId: providerThreadId(stale),
    intent: "interrupt",
    activeTurnId: "exec:gone:1",
  });
  expect(stopped.error).toBeUndefined();
  expect(harness.fake.calls.interrupts).toBe(0);

  const pendingThread = "thr_stop_pending";
  const pending = await harness.startThread(pendingThread);
  const pendingId = providerThreadId(pending);
  const turn = await harness.request(
    "creq_stp2345678",
    "turn/start",
    turnInput(pendingThread, pendingId, "creq_stp2345678", "not started yet"),
  );
  expect(turn.error).toBeUndefined();
  const interrupted = await harness.request(97, "thread/stop", {
    threadId: pendingThread,
    providerThreadId: pendingId,
    intent: "interrupt",
    activeTurnId: "exec:pending:1",
  });
  expect(interrupted.error).toBeUndefined();
  expect(harness.fake.calls.interruptedSessions).toEqual([pendingId]);
});

it("settles an interrupt itself when OpenCode never confirms it", async () => {
  await useHarness({
    scriptTurns: true,
    runtime: { holdInterrupts: true },
    bridge: { interruptSettlementTimeoutMs: 40 },
  });
  const threadId = "thr_interrupt_timeout";
  const { sessionId } = await openTurn(threadId, "/hold", "creq_tim2345678");
  await harness.fake.play({
    type: "session.tool.input.started",
    data: { sessionID: sessionId, id: "tool_1", name: "bash" },
  });
  await harness.waitFor(
    () => harness.deltasOf(threadId).some((delta) => delta.kind === "item.open"),
    "tool open",
  );
  const stopped = await harness.request(98, "thread/stop", {
    threadId,
    providerThreadId: sessionId,
    intent: "interrupt",
    activeTurnId: null,
  });
  expect(stopped.error).toBeUndefined();
  const responseAt = harness.rpc.messages.indexOf(stopped);
  const closeAt = deltaMessageIndex(
    threadId,
    (delta) =>
      delta.kind === "item.close" &&
      delta.status === "interrupted" &&
      isRecord(delta.key) &&
      delta.key.providerItemId === "tool_1",
  );
  const boundaryAt = deltaMessageIndex(
    threadId,
    (delta) => delta.kind === "turn.boundary" && delta.status === "interrupted",
  );
  expect(closeAt).toBeGreaterThanOrEqual(0);
  expect(boundaryAt).toBeGreaterThanOrEqual(closeAt);
  expect(responseAt).toBeGreaterThan(boundaryAt);
  expect(deltaKinds(threadId)).not.toContain("session.ended");
});

it("answers a grandchild's permission on the grandchild and skips unattached children", async () => {
  const replies: Array<{ sessionID: string; requestID: string }> = [];
  const unopenable = new Set<string>();
  const trackReplies = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    replyPermission: async (requestID, reply) => {
      replies.push({ sessionID: handle.id, requestID });
      await handle.replyPermission(requestID, reply);
    },
  });
  await useHarness({
    wrapRuntime: (fake) => ({
      ...fake,
      createSession: async (input) => trackReplies(await fake.createSession(input)),
      openSession: async (sessionID) => {
        if (unopenable.has(sessionID)) throw new Error("child session is gone");
        return trackReplies(await fake.openSession(sessionID));
      },
    }),
  });
  const threadId = "thr_lineage";
  const rootId = providerThreadId(await harness.startThread(threadId));
  const location = { directory: harness.workspaceDir };
  const child = await harness.fake.createSession({ location });
  const grandchild = await harness.fake.createSession({ location });
  await harness.fake.play({
    type: "session.created",
    data: { sessionID: child.id, parentID: rootId, title: "child" },
  });
  await harness.fake.play({
    type: "session.created",
    data: { sessionID: grandchild.id, parentID: child.id, title: "grandchild" },
  });
  harness.fake.emit({
    type: "permission.asked",
    data: { id: "per_grand", sessionID: grandchild.id, action: "read", resources: ["a"] },
  });
  await harness.waitFor(() => interactionRequest() !== undefined, "grandchild permission");
  const request = interactionRequest();
  if (request?.id === undefined) throw new Error("missing grandchild permission");
  harness.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { decision: "allow_once", grantedPermissions: null },
    }),
  );
  await harness.waitFor(() => replies.length === 1, "grandchild reply");
  expect(replies).toEqual([{ sessionID: grandchild.id, requestID: "per_grand" }]);

  const orphan = await harness.fake.createSession({ location });
  unopenable.add(orphan.id);
  await harness.fake.play({
    type: "session.created",
    data: { sessionID: orphan.id, parentID: rootId, title: "orphan" },
  });
  await harness.fake.play({
    type: "permission.asked",
    data: { id: "per_orphan", sessionID: orphan.id, action: "read", resources: ["b"] },
  });
  await harness.waitFor(
    () => harness.deltasOf(threadId).some((delta) => delta.kind === "provider.warning"),
    "orphan warning",
  );
  expect(
    harness
      .deltasOf(threadId)
      .filter((delta) => delta.kind === "unhandled")
      .map((delta) => delta.rawType),
  ).toEqual(["opencode/child-session-unavailable"]);
  expect(
    harness.rpc.messages.filter(
      (message) => message.method === "interaction/request" && message.id !== undefined,
    ),
  ).toHaveLength(1);
  expect(replies).toHaveLength(1);
});

it("backs off and resyncs when the event stream ends", async () => {
  let subscribes = 0;
  let contexts = 0;
  await useHarness({
    bridge: { resubscribeBackoffMs: { initial: 20, max: 40 } },
    wrapRuntime: (fake) => ({
      ...fake,
      createSession: async (input) => {
        const handle = await fake.createSession(input);
        return {
          ...handle,
          context: async () => {
            contexts += 1;
            return handle.context();
          },
        };
      },
      subscribe: (sessionID, signal) => {
        subscribes += 1;
        if (subscribes === 1) {
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => ({ done: true as const, value: undefined }),
            }),
          };
        }
        return fake.subscribe(sessionID, signal);
      },
    }),
  });
  const started = await harness.startThread("thr_stream_end");
  expect(started.error).toBeUndefined();
  const sessionId = providerThreadId(started);
  await harness.waitFor(() => subscribes === 2 && contexts === 1, "resubscribe and resync");
  harness.fake.emit({
    type: "session.execution.started",
    data: { sessionID: sessionId },
  });
  await harness.waitFor(
    () => deltaKinds("thr_stream_end").includes("turn.open"),
    "event on the resubscribed stream",
  );
  expect(subscribes).toBe(2);
  expect(contexts).toBe(1);
  expect(harness.warnings.filter((warning) => warning.includes("resubscribing"))).toEqual([
    "OpenCode event stream for thr_stream_end ended; resubscribing in 20ms",
  ]);
});

it("surfaces a runtime stream.error as a warning and keeps the session attached", async () => {
  let subscribes = 0;
  await useHarness({
    wrapRuntime: (fake) => ({
      ...fake,
      subscribe: (sessionID, signal) => {
        subscribes += 1;
        const events = fake.subscribe(sessionID, signal);
        const disconnected: RuntimeSessionEvent = {
          kind: "stream.error",
          sessionID,
          message: "connection refused",
        };
        return {
          [Symbol.asyncIterator]() {
            const iterator = events[Symbol.asyncIterator]();
            let primed = false;
            return {
              async next() {
                if (!primed) {
                  primed = true;
                  return { done: false, value: disconnected };
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
    }),
  });
  const threadId = "thr_stream_error";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  await harness.waitFor(
    () => harness.deltasOf(threadId).some((delta) => delta.kind === "provider.warning"),
    "stream warning",
  );
  expect(
    harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning"),
  ).toEqual([
    {
      kind: "provider.warning",
      summary: "OpenCode event stream disconnected; reconnecting",
      details: "connection refused",
    },
  ]);
  expect(
    harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.error"),
  ).toEqual([]);
  expect(harness.warnings.some((warning) => warning.includes("connection refused"))).toBe(
    true,
  );
  const turn = await harness.request("creq_zzzzzzzz22", "turn/start", {
    threadId,
    providerThreadId: providerThreadId(started),
    clientRequestId: "creq_zzzzzzzz22",
    input: [{ type: "text", text: "still attached", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(turn.error).toBeUndefined();
  expect(harness.fake.calls.prompts.map((prompt) => prompt.text)).toEqual([
    "still attached",
  ]);
  expect(subscribes).toBe(1);
});

function mention(
  text: string,
  token: string,
  name: string,
  source: "command" | "skill",
  trigger: "/" | "$",
) {
  const start = text.indexOf(token);
  return {
    start,
    end: start + token.length,
    resource: {
      kind: "command" as const,
      trigger,
      name,
      source,
      origin: "user" as const,
      label: name,
      argumentHint: null,
    },
  };
}

async function restartWithSkills(skillIds: readonly string[]): Promise<void> {
  await harness.teardown();
  harness = await startOpenCodeBridgeHarness({
    prefix: "bb-opencode-bridge-methods-",
    scriptTurns: true,
    runtime: {
      skills: skillIds.map((id) => ({ id, name: id, path: `/skills/${id}/SKILL.md` })),
    },
  });
}

it("turn/start leaves the prompt id to OpenCode and keys the accept by the opened turn", async () => {
  const threadId = "thr_no_minted_id";
  await openTurn(threadId, "say hello", "creq_6789abcdef");
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.boundary"),
    "prompt boundary",
  );
  expect(harness.fake.calls.prompts).toEqual([{ text: "say hello", delivery: "steer" }]);
  const open = harness.deltasOf(threadId).find((delta) => delta.kind === "turn.open");
  const accepted = harness
    .deltasOf(threadId)
    .filter((delta) => delta.kind === "input.accepted");
  expect(typeof open?.providerTurnId).toBe("string");
  expect(accepted).toEqual([
    {
      kind: "input.accepted",
      clientRequestId: "creq_6789abcdef",
      providerTurnId: open?.providerTurnId,
    },
  ]);
});

it("turn/start sends a native command with its files, skills, and delivery", async () => {
  await restartWithSkills(["lint"]);
  const threadId = "thr_command_attachments";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const text = "/team:review $lint src/a.ts";
  const notes = join(harness.workspaceDir, "notes.md");
  const response = await harness.request("creq_789abcdefg", "turn/start", {
    threadId,
    providerThreadId: providerThreadId(started),
    clientRequestId: "creq_789abcdefg",
    input: [
      {
        type: "text",
        text,
        mentions: [
          mention(text, "/team:review", "team:review", "command", "/"),
          mention(text, "$lint", "lint", "skill", "$"),
        ],
      },
      { type: "localFile", path: notes, name: "notes.md" },
    ],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error).toBeUndefined();
  expect(harness.fake.calls.prompts).toEqual([]);
  expect(harness.fake.calls.commands).toEqual([
    {
      name: "team/review",
      text: "$lint src/a.ts",
      files: [{ uri: `file://${notes}`, name: "notes.md" }],
      skills: [{ id: "lint" }],
      delivery: "steer",
    },
  ]);
});

it("turn/start queues a native command while the session is busy", async () => {
  const threadId = "thr_command_queued";
  const { sessionId } = await openTurn(threadId, "/hold", "creq_9abcdefghi");
  await harness.waitFor(
    () => deltaKinds(threadId).includes("turn.open"),
    "held turn",
  );
  const text = "/team:review src/a.ts";
  const response = await harness.request("creq_abcdefghij", "turn/start", {
    threadId,
    providerThreadId: sessionId,
    clientRequestId: "creq_abcdefghij",
    input: [
      {
        type: "text",
        text,
        mentions: [mention(text, "/team:review", "team:review", "command", "/")],
      },
    ],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error).toBeUndefined();
  expect(harness.fake.calls.commands).toEqual([
    { name: "team/review", text: "src/a.ts", delivery: "queue" },
  ]);
});

it("turn/start rejects a native command naming an unknown skill before dispatch", async () => {
  await restartWithSkills(["lint"]);
  const threadId = "thr_command_unknown_skill";
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const text = "/team:review $missing";
  const response = await harness.request("creq_89abcdefgh", "turn/start", {
    threadId,
    providerThreadId: providerThreadId(started),
    clientRequestId: "creq_89abcdefgh",
    input: [
      {
        type: "text",
        text,
        mentions: [
          mention(text, "/team:review", "team:review", "command", "/"),
          mention(text, "$missing", "missing", "skill", "$"),
        ],
      },
    ],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error?.message).toBe('Unknown OpenCode skill "missing"');
  expect(harness.fake.calls.commands).toEqual([]);
  expect(deltaKinds(threadId)).not.toContain("input.accepted");
});

const bbEchoTool = {
  name: "bb_echo",
  description: "echo",
  inputSchema: { type: "object" },
};

function unavailableRpc(rpcID: string): Error {
  const message = `RPC is unavailable: ${rpcID}`;
  return new Error(message, { cause: { _tag: "RpcError", type: "rpc.unavailable", message } });
}

it("serializes concurrent turn/start checks into one companion attach", async () => {
  let armed = false;
  let bound = false;
  let turnAttaches = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirst: () => void = () => undefined;
  const firstAttach = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const generation = "gen-1";
  await useHarness({
    scriptTurns: true,
    wrapRuntime: (fake) => ({
      ...fake,
      createSession: async (input) => {
        const handle = await fake.createSession(input);
        return {
          ...handle,
          rpc: async (rpcID, method, payload) => {
            if (rpcID !== "bb.tools.v1") return handle.rpc(rpcID, method, payload);
            if (method === "hello") {
              return { protocol: "bb.tools.v1", version: 1, generation };
            }
            if (method === "status") {
              return bound
                ? { bound: true, generation, epoch: 1 }
                : { bound: false, generation };
            }
            if (method === "attach") {
              if (!armed) {
                bound = true;
                return { bindingID: "b1", capability: "cap-1", generation, epoch: 1 };
              }
              turnAttaches += 1;
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              if (turnAttaches === 1) await firstAttach;
              bound = true;
              inFlight -= 1;
              return { bindingID: "b1", capability: "cap-1", generation, epoch: 1 };
            }
            if (method === "configure" || method === "detach" || method === "reject") return {};
            return handle.rpc(rpcID, method, payload);
          },
        };
      },
    }),
  });
  const threadId = "thr_attach_race";
  const started = await harness.startThread(threadId, { dynamicTools: [bbEchoTool] });
  expect(started.error).toBeUndefined();
  armed = true;
  bound = false;
  const sessionId = providerThreadId(started);
  const turn = (id: number, clientRequestId: string) => {
    harness.rpc.sendRequest(id, "turn/start", {
      threadId,
      providerThreadId: sessionId,
      clientRequestId,
      input: [{ type: "text", text: "go", mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    return harness.rpc.waitForResponse(id);
  };
  const first = turn(801, "creq_23456789ab");
  const second = turn(802, "creq_3456789abd");
  await harness.waitFor(() => turnAttaches === 1, "first turn attach");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(turnAttaches).toBe(1);
  expect(maxInFlight).toBe(1);
  releaseFirst();
  const responses = await Promise.all([first, second]);
  expect(responses.every((response) => response.error === undefined)).toBe(true);
  expect(turnAttaches).toBe(1);
  expect(maxInFlight).toBe(1);
});

it("treats an unregistered companion as native-only and a transport failure as a turn error", async () => {
  const threadId = "thr_companion_absent";
  const started = await harness.startThread(threadId, { dynamicTools: [bbEchoTool] });
  expect(started.error).toBeUndefined();
  expect(
    harness.deltasOf(threadId).some(
      (delta) => delta.kind === "provider.warning" && String(delta.details).includes("bb_echo"),
    ),
  ).toBe(true);
  const native = await harness.request("creq_456789abde", "turn/start", {
    threadId,
    providerThreadId: providerThreadId(started),
    clientRequestId: "creq_456789abde",
    input: [{ type: "text", text: "native", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(native.error).toBeUndefined();

  await useHarness({
    scriptTurns: true,
    wrapRuntime: (fake) => ({
      ...fake,
      createSession: async (input) => {
        const handle = await fake.createSession(input);
        return {
          ...handle,
          rpc: async () => {
            throw new Error("socket hang up");
          },
        };
      },
    }),
  });
  const brokenId = "thr_companion_transport";
  const broken = await harness.startThread(brokenId, { dynamicTools: [bbEchoTool] });
  expect(broken.error).toBeUndefined();
  expect(harness.deltasOf(brokenId).some((delta) => delta.kind === "provider.warning")).toBe(false);
  const failed = await harness.request("creq_56789abdef", "turn/start", {
    threadId: brokenId,
    providerThreadId: providerThreadId(broken),
    clientRequestId: "creq_56789abdef",
    input: [{ type: "text", text: "retry", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(failed.error?.message).toContain("could not be reached");
  expect(failed.error?.message).toContain("socket hang up");
  expect(failed.error?.message).toContain("were not dropped");
  expect(harness.deltasOf(brokenId).some((delta) => delta.kind === "provider.warning")).toBe(false);
  expect(unavailableRpc("bb.tools.v1").message).toBe("RPC is unavailable: bb.tools.v1");
});
