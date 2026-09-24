import { expect, it } from "vitest";
import type { FakeOpenCodeRuntime, OpenCodeNativeEvent, OpenCodeRuntime, SessionHandle } from "../runtime/index.js";
import { startOpenCodeBridgeHarness, type OpenCodeBridgeHarness } from "./test-support.js";

const tool = {
  name: "bb_echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

const TURN_ENDED = "bb turn ended; bb tools are unavailable to background subagents after their owning turn";

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
  resultPayloads?: Array<Record<string, unknown>>;
}

function wrapCompanion(runtime: FakeOpenCodeRuntime, hooks: CompanionHooks): OpenCodeRuntime {
  let boundEpoch = hooks.epoch ?? 1;
  const wrap = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    durableLog: async () => hooks.durableLog?.() ?? handle.durableLog(),
    rpc: async (_rpcID, method, payload) => {
      const input = isRecord(payload) ? payload : {};
      const generation = hooks.generation?.() ?? "gen-1";
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation };
      if (method === "status") return { bound: true, generation, epoch: boundEpoch };
      if (method === "attach") {
        hooks.attaches.count += 1;
        boundEpoch = hooks.attaches.count;
        return {
          bindingID: `b${hooks.attaches.count}`,
          capability: `cap-${hooks.attaches.count}`,
          generation,
          epoch: boundEpoch,
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

function pendingCall(sessionID: string, messageID: string) {
  return {
    calls: [
      {
        key: "k1",
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

it("holds an unmapped call until the assistant step event, then dispatches it on the live turn", async () => {
  const rejects: string[] = [];
  let offer = false;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => (offer ? pendingCall(opened.providerThreadId, "msg_fast") : { calls: [], settled: [] }),
    onReject: (input) => {
      if (typeof input.message === "string") rejects.push(input.message);
    },
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
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(opened.harness.rpc.messages.some((message) => message.method === "item/tool/call")).toBe(false);
    expect(rejects).toEqual([]);
    await opened.harness.fake.play({
      type: "session.step.started",
      data: { sessionID: opened.providerThreadId, assistantMessageID: "msg_fast" },
    });
    await opened.harness.waitFor(
      () => opened.harness.rpc.messages.some((message) => message.method === "item/tool/call"),
      "reverse item/tool/call",
    );
    const call = opened.harness.rpc.messages.find((message) => message.method === "item/tool/call");
    expect(call?.params).toMatchObject({ turnId: openTurnId(opened.harness), tool: "bb_echo" });
    expect(rejects).toEqual([]);
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
