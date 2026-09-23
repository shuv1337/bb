import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  type OpenCodeBridgeHarness,
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
