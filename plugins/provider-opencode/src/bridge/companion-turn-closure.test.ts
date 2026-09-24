import { expect, it } from "vitest";
import type { FakeOpenCodeRuntime, OpenCodeNativeEvent, OpenCodeRuntime, SessionHandle } from "../runtime/index.js";
import { startOpenCodeBridgeHarness, type OpenCodeBridgeHarness } from "./test-support.js";

const tool = {
  name: "bb_echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

const TURN_ENDED = "bb turn ended; bb tools are unavailable to background subagents after their owning turn";
const ORIGIN_UNKNOWN = "bb tool origin could not be established; the call was not run";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CompanionHooks {
  generation?: () => string;
  attaches: { count: number };
  pending?: () => unknown;
  onResult?: () => Promise<void> | void;
  onReject?: (input: Record<string, unknown>) => void;
  onDetach?: (capability: string) => void;
  onConfigure?: (capability: string) => void;
  epoch?: number;
  durableLog?: () => Promise<readonly OpenCodeNativeEvent[]>;
  durableLogComplete?: boolean;
  resultPayloads?: Array<Record<string, unknown>>;
}

function wrapCompanion(runtime: FakeOpenCodeRuntime, hooks: CompanionHooks): OpenCodeRuntime {
  let boundEpoch = hooks.epoch ?? 1;
  const wrap = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    durableLog: async () => {
      if (hooks.durableLog !== undefined) {
        return { events: await hooks.durableLog(), complete: hooks.durableLogComplete !== false };
      }
      return handle.durableLog();
    },
    rpc: async (_rpcID, method, payload) => {
      const input = isRecord(payload) ? payload : {};
      const generation = hooks.generation?.() ?? "gen-1";
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation };
      if (method === "status") {
        return {
          bound: true,
          generation,
          epoch: boundEpoch,
          catalogDigest: "a".repeat(64),
          leaseExpiresAt: 1,
        };
      }
      if (method === "attach") {
        hooks.attaches.count += 1;
        boundEpoch = hooks.attaches.count;
        return {
          bindingID: `b${hooks.attaches.count}`,
          capability: `cap-${hooks.attaches.count}`,
          generation,
          epoch: boundEpoch,
          catalogDigest: "a".repeat(64),
          ownerLeaseMs: 30_000,
        };
      }
      if (method === "pending") return hooks.pending?.() ?? { calls: [], settled: [] };
      if (method === "claim") return {};
      if (method === "result") {
        hooks.resultPayloads?.push(input);
        await hooks.onResult?.();
        return {};
      }
      if (method === "reject") {
        hooks.onReject?.(input);
        return {};
      }
      if (method === "detach") {
        if (typeof input.capability === "string") hooks.onDetach?.(input.capability);
        return {};
      }
      if (method === "configure") {
        if (typeof input.capability === "string") hooks.onConfigure?.(input.capability);
        return {};
      }
      return {};
    },
  });
  return {
    ...runtime,
    async createSession(input) {
      return wrap(await runtime.createSession(input));
    },
    async openSession(id) {
      return wrap(await runtime.openSession(id));
    },
  };
}

async function openHarness(hooks: CompanionHooks): Promise<{
  harness: OpenCodeBridgeHarness;
  providerThreadId: string;
}> {
  const harness = await startOpenCodeBridgeHarness({
    scriptTurns: false,
    wrapRuntime: (fake) => wrapCompanion(fake, hooks),
  });
  const started = await harness.startThread("thr_turn", { dynamicTools: [tool] });
  expect(started.error).toBeUndefined();
  return {
    harness,
    providerThreadId: (started.result as { providerThreadId: string }).providerThreadId,
  };
}

function openTurnId(harness: OpenCodeBridgeHarness): string {
  const open = harness
    .deltasOf("thr_turn")
    .find((delta) => delta.kind === "turn.open" && delta.parentRef === undefined);
  if (typeof open?.providerTurnId !== "string") throw new Error("missing open turn id");
  return open.providerTurnId;
}

function pendingCall(sessionID: string, messageID: string, key = "k1") {
  return {
    calls: [
      {
        key,
        sessionID,
        messageID,
        callID: "call_1",
        tool: "bb_echo",
        arguments: { text: "x" },
        origin: { rootSessionID: sessionID, rootMessageID: messageID },
        state: "pending" as const,
      },
    ],
    settled: [],
  };
}

async function openExecution(harness: OpenCodeBridgeHarness, providerThreadId: string, messageID: string): Promise<string> {
  await harness.fake.play({
    type: "session.execution.started",
    data: { sessionID: providerThreadId },
    durable: { seq: 4 },
  });
  await harness.waitFor(
    () => harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
    "turn.open",
  );
  await harness.fake.play({
    type: "session.step.started",
    data: { sessionID: providerThreadId, assistantMessageID: messageID },
  });
  return openTurnId(harness);
}

it("settles companion calls locally before publishing the boundary", async () => {
  const log: string[] = [];
  let offer = false;
  let offered = false;
  let live: OpenCodeBridgeHarness | undefined;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => {
      if (!offer || offered || live === undefined) return { calls: [], settled: [] };
      offered = true;
      return pendingCall(opened.providerThreadId, "msg_1");
    },
    onResult: () => {
      log.push("result");
      expect(live?.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    },
  });
  live = opened.harness;
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_1");
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    await opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn.boundary",
    );
    expect(log).toContain("result");
    expect(opened.harness.rpc.messages.some((message) => message.method === "notifications/cancelled")).toBe(true);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("retries a failed companion result to the same binding and drops the record after acknowledgement", async () => {
  let resultCalls = 0;
  let offer = true;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_retry") : { calls: [], settled: [] }),
    onResult: () => {
      resultCalls += 1;
      if (resultCalls === 1) throw new Error("delivery failed");
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_retry");
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    const reverse = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    opened.harness.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reverse?.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "echo: ok" }] },
      }),
    );
    await opened.harness.waitFor(() => resultCalls >= 2, "retried result");
    expect(resultCalls).toBe(2);
    expect(opened.harness.rpc.messages.filter((message) => message.method === "item/tool/call")).toHaveLength(1);
    offer = false;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resultCalls).toBe(2);
    expect(opened.harness.rpc.messages.filter((message) => message.method === "item/tool/call")).toHaveLength(1);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("leaves a replacement binding untouched when a boundary is still settling the previous one", async () => {
  const attaches = { count: 0 };
  const detaches: string[] = [];
  const configures: string[] = [];
  const pendingCaps: string[] = [];
  let releaseResult: () => void = () => undefined;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let resultEntered = false;
  let generation = "gen-1";
  const opened = await openHarness({
    attaches,
    generation: () => generation,
    pending: () => {
      const capability = `cap-${attaches.count}`;
      pendingCaps.push(capability);
      if (attaches.count !== 1 || resultEntered) return { calls: [], settled: [] };
      return pendingCall(opened.providerThreadId, "msg_race");
    },
    onResult: async () => {
      resultEntered = true;
      await resultGate;
    },
    onDetach: (capability) => {
      detaches.push(capability);
    },
    onConfigure: (capability) => {
      configures.push(capability);
    },
  });
  try {
    const turnId = await openExecution(opened.harness, opened.providerThreadId, "msg_race");
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    const closing = opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(() => resultEntered, "boundary result delivery");
    generation = "gen-2";
    const steered = opened.harness.request("creq_3456789abd", "turn/steer", {
      threadId: "thr_turn",
      providerThreadId: opened.providerThreadId,
      expectedTurnId: turnId,
      clientRequestId: "creq_3456789abd",
      input: [{ type: "text", text: "steer", mentions: [] }],
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(attaches.count).toBe(1);
    releaseResult();
    await closing;
    await steered;
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn.boundary",
    );
    const boundary = opened.harness.deltasOf("thr_turn").find((delta) => delta.kind === "turn.boundary");
    expect(boundary?.providerTurnId).toBe(turnId);
    const next = await opened.harness.request("creq_456789abde", "turn/start", {
      threadId: "thr_turn",
      providerThreadId: opened.providerThreadId,
      clientRequestId: "creq_456789abde",
      input: [{ type: "text", text: "again", mentions: [] }],
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
    });
    expect(next.error).toBeUndefined();
    expect(attaches.count).toBe(2);
    expect(configures).toContain("cap-2");
    expect(detaches).not.toContain("cap-2");
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "later" },
    });
    await opened.harness.waitFor(() => pendingCaps.includes("cap-2"), "binding 2 still current");
    expect(detaches).not.toContain("cap-2");
  } finally {
    releaseResult();
    await opened.harness.teardown();
  }
}, 15_000);

it("does not let an aborted earlier execution borrow a later turn", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_old") : { calls: [], settled: [] }),
    durableLog: async () => [
      {
        type: "session.execution.started",
        data: { sessionID: opened.providerThreadId },
        durable: { seq: 1 },
      },
      {
        type: "session.step.started",
        data: { sessionID: opened.providerThreadId, assistantMessageID: "msg_old" },
      },
      {
        type: "session.execution.interrupted",
        data: { sessionID: opened.providerThreadId },
      },
      {
        type: "session.execution.started",
        data: { sessionID: opened.providerThreadId },
        durable: { seq: 9 },
      },
    ],
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
  });
  try {
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
      durable: { seq: 9 },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
      "later turn.open",
    );
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(() => rejects.length > 0, "old origin rejected");
    expect(rejects).toEqual([TURN_ENDED]);
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
    expect(openTurnId(opened.harness)).toContain(":9");
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("rejects a call whose origin is not in the durable log instead of borrowing the live turn", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_missing") : { calls: [], settled: [] }),
    durableLog: async () => [
      {
        type: "session.execution.started",
        data: { sessionID: opened.providerThreadId },
        durable: { seq: 4 },
      },
    ],
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_other");
    await opened.harness.injectResync("thr_turn");
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(() => rejects.includes(ORIGIN_UNKNOWN), "unlinked origin rejected");
    expect(rejects).toContain(ORIGIN_UNKNOWN);
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("rejects a call whose origin turn has closed and does not dispatch it", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_closed") : { calls: [], settled: [] }),
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_closed");
    await opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn.boundary",
    );
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(() => rejects.length > 0, "origin rejection");
    expect(rejects).toEqual([TURN_ENDED]);
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("rebuilds a lost origin from the durable log and dispatches the live turn", async () => {
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_gap") : { calls: [], settled: [] }),
    durableLog: async () => [
      {
        type: "session.execution.started",
        data: { sessionID: opened.providerThreadId },
        durable: { seq: 4 },
      },
      {
        type: "session.step.started",
        data: { sessionID: opened.providerThreadId, assistantMessageID: "msg_gap" },
      },
    ],
  });
  try {
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
      durable: { seq: 4 },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
      "turn.open",
    );
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "rebuilt reverse call",
    );
    const call = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    expect(call?.params).toMatchObject({ turnId: openTurnId(opened.harness) });
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("stops result delivery after a finite budget instead of retrying immediately", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let offer = true;
  const opened = await openHarness({
    attaches: { count: 0 },
    resultPayloads: payloads,
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_budget") : { calls: [], settled: [] }),
    onResult: () => {
      throw new Error("delivery failed");
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_budget");
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    const reverse = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    opened.harness.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reverse?.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "echo: ok" }] },
      }),
    );
    const budgetDeadline = Date.now() + 12_000;
    while (payloads.filter((payload) => payload.success === false).length < 1) {
      if (Date.now() > budgetDeadline) throw new Error(`delivery budget did not settle: ${JSON.stringify(payloads)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const successes = payloads.filter((payload) => payload.success === true);
    expect(successes.length).toBe(5);
    expect(payloads.filter((payload) => payload.success === false)).toHaveLength(1);
    const settledAt = payloads.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(payloads).toHaveLength(settledAt);
  } finally {
    await opened.harness.teardown();
  }
}, 20_000);

it("finishes a hanging result delivery after the per-attempt timeout", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let offer = true;
  const opened = await openHarness({
    attaches: { count: 0 },
    resultPayloads: payloads,
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_hang") : { calls: [], settled: [] }),
    onResult: () => new Promise(() => undefined),
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_hang");
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    const reverse = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    opened.harness.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reverse?.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "echo: ok" }] },
      }),
    );
    const deadline = Date.now() + 25_000;
    while (payloads.filter((payload) => payload.success === false).length < 1) {
      if (Date.now() > deadline) throw new Error(`hanging delivery did not finish: ${payloads.length}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(payloads.filter((payload) => payload.success === true)).toHaveLength(5);
    expect(payloads.filter((payload) => payload.success === false)).toHaveLength(1);
    const settledAt = payloads.length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(payloads).toHaveLength(settledAt);
  } finally {
    await opened.harness.teardown();
  }
}, 40_000);

it("drops a stale boundary for turn N once turn N+1 is live and closes each opened turn once", async () => {
  const opened = await openHarness({ attaches: { count: 0 } });
  try {
    const first = await openExecution(opened.harness, opened.providerThreadId, "msg_n");
    await opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn N boundary",
    );
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
      durable: { seq: 9 },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").filter((delta) => delta.kind === "turn.open").length >= 2,
      "turn N+1 open",
    );
    const later = opened.harness.deltasOf("thr_turn").filter((delta) => delta.kind === "turn.open").at(-1);
    const before = opened.harness.deltasOf("thr_turn").filter((delta) => delta.kind === "turn.boundary");
    await opened.harness.injectTurnDeltas("thr_turn", [
      { kind: "turn.boundary", providerTurnId: first, status: "completed" },
    ]);
    const boundaries = opened.harness.deltasOf("thr_turn").filter((delta) => delta.kind === "turn.boundary");
    expect(before.filter((delta) => delta.providerTurnId === first)).toHaveLength(1);
    expect(boundaries.filter((delta) => delta.providerTurnId === first)).toHaveLength(1);
    expect(boundaries.filter((delta) => delta.providerTurnId === later?.providerTurnId)).toEqual(
      before.filter((delta) => delta.providerTurnId === later?.providerTurnId),
    );
    expect(
      opened.harness.warnings.some(
        (message) => message.includes(`dropping stale turn boundary ${first}`) || message.includes(`publishing late turn boundary ${first}`),
      ),
    ).toBe(true);
    expect(opened.harness.warnings.some((message) => message.includes(String(later?.providerTurnId)))).toBe(true);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("does not cancel an in-flight later turn when a late boundary for the previous turn arrives", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    resultPayloads: payloads,
    pending: () =>
      offer ? pendingCall(opened.providerThreadId, "msg_n1", "k-next") : { calls: [], settled: [] },
  });
  try {
    const first = await openExecution(opened.harness, opened.providerThreadId, "msg_n");
    await opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn N boundary",
    );
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
      durable: { seq: 9 },
    });
    await opened.harness.fake.play({
      type: "session.step.started",
      data: { sessionID: opened.providerThreadId, assistantMessageID: "msg_n1" },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").filter((delta) => delta.kind === "turn.open").length >= 2,
      "turn N+1 open",
    );
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k-next" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "N+1 reverse item/tool/call",
    );
    const reverse = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    const cancelledBefore = opened.harness.rpc.messages.filter((message) => message.method === "notifications/cancelled");
    await opened.harness.injectTurnDeltas("thr_turn", [
      { kind: "turn.boundary", providerTurnId: first, status: "completed" },
    ]);
    const cancelledAfter = opened.harness.rpc.messages.filter((message) => message.method === "notifications/cancelled");
    expect(cancelledAfter).toEqual(cancelledBefore);
    expect(JSON.stringify(cancelledAfter)).not.toContain(String(reverse?.id));
    opened.harness.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reverse?.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "echo: kept" }] },
      }),
    );
    await opened.harness.waitFor(
      () => payloads.some((payload) => payload.success === true && JSON.stringify(payload).includes("echo: kept")),
      "N+1 result delivered",
    );
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("rejects an unmapped call after one completed recovery instead of waiting for a step event", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_missing") : { calls: [], settled: [] }),
    durableLog: async () => [
      {
        type: "session.execution.started",
        data: { sessionID: opened.providerThreadId },
        durable: { seq: 4 },
      },
    ],
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_other");
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(() => rejects.includes(ORIGIN_UNKNOWN), "unlinked origin rejected");
    expect(rejects).toContain(ORIGIN_UNKNOWN);
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("rejects an unmapped call when durable log recovery stops before log.synced", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    durableLogComplete: false,
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_missing") : { calls: [], settled: [] }),
    durableLog: async () => [
      {
        type: "session.step.started",
        data: { sessionID: opened.providerThreadId, assistantMessageID: "msg_missing" },
      },
    ],
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
  });
  try {
    await openExecution(opened.harness, opened.providerThreadId, "msg_other");
    offer = true;
    await opened.harness.fake.play({
      type: "rpc.bb.tools.v1.control",
      data: { type: "pending", sessionID: opened.providerThreadId, key: "k1" },
    });
    await opened.harness.waitFor(() => rejects.includes(ORIGIN_UNKNOWN), "incomplete recovery rejected");
    expect(rejects).toContain(ORIGIN_UNKNOWN);
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
    expect(opened.harness.warnings.some((message) => message.includes("stopped before log.synced"))).toBe(true);
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);
