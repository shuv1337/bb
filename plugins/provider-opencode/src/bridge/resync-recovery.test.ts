import { expect, it } from "vitest";
import { UNOBSERVED_TOOL_OUTCOME } from "../delta-translation.js";
import { startOpenCodeBridgeHarness } from "./test-support.js";

async function openTurn(threadId: string) {
  const harness = await startOpenCodeBridgeHarness({
    prefix: "bb-opencode-resync-",
    scriptTurns: false,
  });
  const started = await harness.startThread(threadId);
  const result = started.result;
  if (result === null || typeof result !== "object" || !("providerThreadId" in result)) {
    throw new Error("missing providerThreadId");
  }
  const sessionId = String(result.providerThreadId);
  await harness.fake.play({
    type: "session.execution.started",
    data: { sessionID: sessionId },
    durable: { aggregateID: sessionId, seq: 1, version: 1 },
  });
  await harness.fake.play({
    type: "session.tool.input.started",
    data: { sessionID: sessionId, id: "call_open", name: "read" },
    durable: { aggregateID: sessionId, seq: 2, version: 1 },
  });
  await harness.rpc.flushWork();
  return { harness, sessionId };
}

it("keeps a still-active session open when the log has no terminal", async () => {
  const { harness, sessionId } = await openTurn("thr_active");
  try {
    harness.fake.setActivity(sessionId, { outcome: undefined, idleAt: undefined, active: true });
    await harness.injectResync("thr_active");
    expect(harness.deltasOf("thr_active").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(harness.deltasOf("thr_active").some((delta) => delta.kind === "item.close")).toBe(false);
  } finally {
    await harness.teardown();
  }
});

it("closes an idle session from its outcome when the log has no terminal", async () => {
  const { harness, sessionId } = await openTurn("thr_idle");
  try {
    harness.fake.setActivity(sessionId, { outcome: "interrupted", idleAt: 4, active: false });
    await harness.injectResync("thr_idle");
    expect(harness.deltasOf("thr_idle")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "item.close",
          status: "interrupted",
          resultText: UNOBSERVED_TOOL_OUTCOME,
        }),
        expect.objectContaining({ kind: "turn.boundary", status: "interrupted" }),
      ]),
    );
  } finally {
    await harness.teardown();
  }
});

it("closes a stale turn as unobserved when a new execution starts after two failed activity reads", async () => {
  const { harness, sessionId } = await openTurn("thr_stale");
  try {
    harness.fake.setActivity(sessionId, "fail");
    await harness.injectResync("thr_stale");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.deltasOf("thr_stale").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    const started = await harness.request("creq_23456789ab", "turn/start", {
      threadId: "thr_stale",
      providerThreadId: sessionId,
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "again", mentions: [] }],
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
    });
    expect(started.error).toBeUndefined();
    await harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: sessionId },
      durable: { aggregateID: sessionId, seq: 9, version: 1 },
    });
    await harness.rpc.flushWork();
    const boundary = harness.deltasOf("thr_stale").find((delta) => delta.kind === "turn.boundary");
    expect(boundary).toMatchObject({
      status: "failed",
      providerTurnId: `exec:${sessionId}:1`,
      error: { message: UNOBSERVED_TOOL_OUTCOME },
    });
    expect(boundary?.status).not.toBe("completed");
    expect(harness.deltasOf("thr_stale")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "item.close",
          status: "failed",
          resultText: UNOBSERVED_TOOL_OUTCOME,
        }),
        expect.objectContaining({
          kind: "turn.open",
          providerTurnId: `exec:${sessionId}:9`,
        }),
      ]),
    );
  } finally {
    await harness.teardown();
  }
});

it("releases a stale open turn as unobserved rather than successful", async () => {
  const { harness, sessionId } = await openTurn("thr_release");
  try {
    const stopped = await harness.request(81, "thread/stop", {
      threadId: "thr_release",
      providerThreadId: sessionId,
      intent: "release",
      activeTurnId: null,
    });
    expect(stopped.error).toBeUndefined();
    const boundary = harness.deltasOf("thr_release").find((delta) => delta.kind === "turn.boundary");
    expect(boundary).toMatchObject({
      status: "failed",
      error: { message: UNOBSERVED_TOOL_OUTCOME },
    });
    expect(boundary?.status).not.toBe("completed");
  } finally {
    await harness.teardown();
  }
});

it("keeps the turn open after a failed activity read and retries once", async () => {
  const { harness, sessionId } = await openTurn("thr_retry");
  try {
    harness.fake.setActivity(sessionId, "fail");
    await harness.injectResync("thr_retry");
    expect(harness.deltasOf("thr_retry").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    harness.fake.setActivity(sessionId, { outcome: "failed", idleAt: 8, active: false });
    await harness.waitFor(
      () => harness.deltasOf("thr_retry").some((delta) => delta.kind === "turn.boundary"),
      "activity retry",
    );
    expect(harness.deltasOf("thr_retry")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "item.close",
          status: "failed",
          resultText: UNOBSERVED_TOOL_OUTCOME,
        }),
        expect.objectContaining({ kind: "turn.boundary", status: "failed" }),
      ]),
    );
  } finally {
    await harness.teardown();
  }
});
