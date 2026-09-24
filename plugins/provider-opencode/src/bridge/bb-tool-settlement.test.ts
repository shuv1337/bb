import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createFakeOpenCodeRuntime,
  type FakeOpenCodeRuntime,
  type OpenCodeRuntime,
  type SessionHandle,
} from "../runtime/index.js";
import {
  startOpenCodeBridgeHarness,
  type OpenCodeBridgeHarness,
} from "./test-support.js";

const tool = {
  name: "bb_echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wrapHangingRpc(fake: FakeOpenCodeRuntime, resultCalls: { count: number }): OpenCodeRuntime {
  const wrap = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    rpc: async (_rpcID, method) => {
      const generation = "gen-hang";
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation };
      if (method === "status") return { bound: true, generation, epoch: "b-hang" };
      if (method === "attach") {
        return { bindingID: "b-hang", capability: "cap-hang", generation, epoch: "b-hang" };
      }
      if (method === "pending") {
        return {
          calls: [
            {
              key: "k1",
              sessionID: handle.id,
              callID: "call_1",
              tool: "bb_echo",
              arguments: { text: "x" },
              state: "pending",
            },
          ],
          settled: [],
        };
      }
      if (method === "claim") return {};
      if (method === "result") {
        resultCalls.count += 1;
        return hang();
      }
      if (method === "detach") return hang();
      return {};
    },
  });
  return {
    ...fake,
    async createSession(input) {
      return wrap(await fake.createSession(input));
    },
    async openSession(id) {
      return wrap(await fake.openSession(id));
    },
  };
}

async function openClaimedCall(resultCalls: { count: number }): Promise<{
  harness: OpenCodeBridgeHarness;
  dataDir: string;
  providerThreadId: string;
  reverseId: string | number;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-tool-settle-"));
  const fake = createFakeOpenCodeRuntime({ scriptTurns: true });
  const harness = await startOpenCodeBridgeHarness({
    fake,
    dataDir,
    wrapRuntime: (runtime) => wrapHangingRpc(runtime, resultCalls),
  });
  const started = await harness.startThread("thr_hang", { dynamicTools: [tool] });
  expect(started.error).toBeUndefined();
  const providerThreadId = (started.result as { providerThreadId: string }).providerThreadId;
  await fake.play({
    type: "rpc.bb.tools.v1.control",
    data: { type: "pending", sessionID: providerThreadId, key: "k1" },
  });
  await harness.waitFor(
    () => harness.rpc.messages.some((message) => message.method === "item/tool/call"),
    "reverse item/tool/call",
  );
  const reverse = harness.rpc.messages.find((message) => message.method === "item/tool/call");
  if (reverse?.id === undefined || reverse.id === null) throw new Error("missing reverse id");
  return { harness, dataDir, providerThreadId, reverseId: reverse.id };
}

afterEach(() => {
  // harness teardown is per test
});

it("thread/stop completes when companion result RPC never resolves", async () => {
  const resultCalls = { count: 0 };
  const opened = await openClaimedCall(resultCalls);
  try {
    const stopped = await withDeadline(
      opened.harness.request(80, "thread/stop", {
        threadId: "thr_hang",
        providerThreadId: opened.providerThreadId,
        intent: "release",
        activeTurnId: null,
      }),
      4_000,
    );
    expect(stopped.error).toBeUndefined();
    expect(resultCalls.count).toBe(1);
    opened.harness.handleLine(JSON.stringify({ jsonrpc: "2.0", id: opened.reverseId, result: { success: true, contentItems: [] } }));
    expect(resultCalls.count).toBe(1);
    expect(
      opened.harness.rpc.messages.filter((message) => message.method === "notifications/cancelled"),
    ).toHaveLength(1);
  } finally {
    rmSync(opened.dataDir, { recursive: true, force: true });
    await withDeadline(opened.harness.closeAll(), 4_000);
  }
}, 15_000);

it("thread/discard completes when companion RPC never resolves", async () => {
  const resultCalls = { count: 0 };
  const opened = await openClaimedCall(resultCalls);
  try {
    const discarded = await withDeadline(
      opened.harness.request(81, "thread/discard", {
        threadId: "thr_hang",
        providerThreadId: opened.providerThreadId,
      }),
      4_000,
    );
    expect(discarded.error).toBeUndefined();
  } finally {
    rmSync(opened.dataDir, { recursive: true, force: true });
    await withDeadline(opened.harness.closeAll(), 4_000);
  }
}, 15_000);

it("closeAll completes when companion RPC never resolves", async () => {
  const resultCalls = { count: 0 };
  const opened = await openClaimedCall(resultCalls);
  try {
    await withDeadline(opened.harness.closeAll(), 4_000);
  } finally {
    rmSync(opened.dataDir, { recursive: true, force: true });
  }
}, 15_000);

it("chooses cancellation over a late bb result without a second settlement", async () => {
  const resultCalls = { count: 0 };
  const opened = await openClaimedCall(resultCalls);
  try {
    const stopped = await withDeadline(
      opened.harness.request(82, "thread/stop", {
        threadId: "thr_hang",
        providerThreadId: opened.providerThreadId,
        intent: "release",
        activeTurnId: null,
      }),
      4_000,
    );
    expect(stopped.error).toBeUndefined();
    opened.harness.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: opened.reverseId,
        result: { success: true, contentItems: [{ type: "inputText", text: "late" }] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resultCalls.count).toBe(1);
    expect(
      opened.harness.rpc.messages.filter((message) => message.method === "notifications/cancelled"),
    ).toHaveLength(1);
  } finally {
    rmSync(opened.dataDir, { recursive: true, force: true });
    await withDeadline(opened.harness.closeAll(), 4_000);
  }
}, 15_000);
