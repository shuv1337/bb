import { describe, expect, it } from "vitest";
import type { SessionHandle } from "../runtime/index.js";
import { createBbToolCalls, type BbToolHost } from "./tool-calls.js";

function host(partial: Partial<BbToolHost> & Pick<BbToolHost, "handle">): BbToolHost {
  return {
    threadId: "thr",
    closed: false,
    turnOpen: true,
    busy: true,
    disallowedTools: [],
    hasDeferredResync: false,
    liveTurnId: () => "exec:ses:1",
    executionTurnId: () => "exec:ses:1",
    warn: () => undefined,
    send: () => undefined,
    enqueue: (work) => work(),
    durableLog: async () => ({ events: [], complete: true }),
    emitTurnDeltas: async () => undefined,
    settleTurn: () => [],
    reconcileAfterResync: () => [],
    takeDeferredResync: () => undefined,
    setDeferredResync: () => undefined,
    ...partial,
  };
}

describe("bb tool call lifecycle", () => {
  it("invokes the owner heartbeat hook while a binding is polling and keeps polling if it throws", async () => {
    const ticks: string[] = [];
    const warnings: string[] = [];
    let calls = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") return { bound: true, generation: "g", epoch: 1 };
      if (method === "attach") return { bindingID: "b", capability: "cap", generation: "g", epoch: 1 };
      if (method === "pending") return { calls: [], settled: [] };
      return {};
    };
    const handle = {
      id: "ses",
      location: { directory: "/a" },
      rpc,
    } as SessionHandle;
    const callsApi = createBbToolCalls({ pollMs: 15 });
    callsApi.setHeartbeat(() => {
      calls += 1;
      ticks.push("tick");
      if (calls === 1) throw new Error("heartbeat down");
    });
    const session = callsApi.bind(
      host({
        handle,
        warn: (message) => warnings.push(message),
        turnOpen: true,
        busy: true,
      }),
    );
    await session.attach([
      { name: "bb_echo", description: "echo", inputSchema: { type: "object" } },
    ]);
    session.ensurePoll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ticks.length).toBeGreaterThan(0);
    expect(warnings.some((message) => message.includes("heartbeat failed"))).toBe(true);
  });
});
