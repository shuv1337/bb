import { expect, it } from "vitest";
import type { FakeOpenCodeRuntime, OpenCodeRuntime, SessionHandle } from "../runtime/index.js";
import { startOpenCodeBridgeHarness, type OpenCodeBridgeHarness } from "./test-support.js";

const tool = {
  name: "bb_echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TurnNotice {
  state?: string;
  turnId?: string;
  capability?: string;
}

interface CompanionHooks {
  generation?: () => string;
  attaches: { count: number };
  pending?: () => unknown;
  hangClose?: boolean;
  onTurn?: (notice: TurnNotice) => void;
  onResult?: () => void;
}

function wrapCompanion(runtime: FakeOpenCodeRuntime, hooks: CompanionHooks): OpenCodeRuntime {
  const wrap = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    rpc: async (_rpcID, method, payload) => {
      const input = isRecord(payload) ? payload : {};
      const generation = hooks.generation?.() ?? "gen-1";
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation };
      if (method === "status") return { bound: true, generation, epoch: "b1" };
      if (method === "attach") {
        hooks.attaches.count += 1;
        return {
          bindingID: `b${hooks.attaches.count}`,
          capability: `cap-${hooks.attaches.count}`,
          generation,
          epoch: "b1",
        };
      }
      if (method === "pending") return hooks.pending?.() ?? { calls: [], settled: [] };
      if (method === "claim" || method === "detach") return {};
      if (method === "result") {
        hooks.onResult?.();
        return {};
      }
      if (method === "turn") {
        if (hooks.hangClose === true && input.state === "closed") return hang();
        hooks.onTurn?.({
          ...(typeof input.state === "string" ? { state: input.state } : {}),
          ...(typeof input.turnId === "string" ? { turnId: input.turnId } : {}),
          ...(typeof input.capability === "string" ? { capability: input.capability } : {}),
        });
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

it("settles companion calls, closes the turn, then publishes the boundary", async () => {
  const log: string[] = [];
  let offer = false;
  let offered = false;
  let turnId = "";
  let live: OpenCodeBridgeHarness | undefined;
  const opened = await openHarness({
    attaches: { count: 0 },
    pending: () => {
      if (!offer || offered || turnId.length === 0) return { calls: [], settled: [] };
      offered = true;
      return {
        calls: [
          {
            key: "k1",
            sessionID: "ses",
            callID: "call_1",
            tool: "bb_echo",
            arguments: { text: "x" },
            turnId,
            state: "pending",
          },
        ],
        settled: [],
      };
    },
    onResult: () => {
      log.push("result");
    },
    onTurn: (notice) => {
      if (notice.state !== "closed" || live === undefined) return;
      log.push("turn:closed");
      expect(live.rpc.messages.some((message) => message.method === "notifications/cancelled")).toBe(
        true,
      );
      expect(log).toContain("result");
      expect(live.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary")).toBe(false);
    },
  });
  live = opened.harness;
  try {
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
      "turn.open",
    );
    turnId = openTurnId(opened.harness);
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
    expect(log.indexOf("turn:closed")).toBeGreaterThan(log.indexOf("result"));
    expect(opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary")).toBe(
      true,
    );
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("detaches a binding when close times out and reattaches on the next turn", async () => {
  const attaches = { count: 0 };
  const opened = await openHarness({ attaches, hangClose: true });
  try {
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
      "turn.open",
    );
    expect(attaches.count).toBe(1);
    const started = Date.now();
    await opened.harness.fake.play({
      type: "session.execution.succeeded",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.boundary"),
      "turn.boundary",
    );
    expect(Date.now() - started).toBeLessThan(3_500);
    const next = await opened.harness.request("creq_23456789ab", "turn/start", {
      threadId: "thr_turn",
      providerThreadId: opened.providerThreadId,
      clientRequestId: "creq_23456789ab",
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
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);

it("reannounces the open turn after a new binding attaches", async () => {
  let generation = "gen-1";
  const attaches = { count: 0 };
  const opens: TurnNotice[] = [];
  const opened = await openHarness({
    attaches,
    generation: () => generation,
    onTurn: (notice) => {
      if (notice.state === "open") opens.push(notice);
    },
  });
  try {
    await opened.harness.fake.play({
      type: "session.execution.started",
      data: { sessionID: opened.providerThreadId },
    });
    await opened.harness.waitFor(
      () => opened.harness.deltasOf("thr_turn").some((delta) => delta.kind === "turn.open"),
      "turn.open",
    );
    const turnId = openTurnId(opened.harness);
    expect(opens.map((notice) => notice.turnId)).toEqual([turnId]);
    expect(opens[0]?.capability).toBe("cap-1");
    generation = "gen-2";
    const steered = await opened.harness.request("creq_3456789abd", "turn/steer", {
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
    expect(steered.error).toBeUndefined();
    expect(attaches.count).toBe(2);
    expect(opens.map((notice) => notice.turnId)).toEqual([turnId, turnId]);
    expect(opens[1]?.capability).toBe("cap-2");
  } finally {
    await opened.harness.teardown();
  }
}, 15_000);
