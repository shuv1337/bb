import { describe, expect, it } from "vitest";
import { OpenCodeUnauthenticatedError } from "./errors.js";
import {
  BB_TOOLS_RPC,
  BbToolsRpcError,
  classifyBbToolsRpcError,
  createBbToolsClient,
  isCompanionAbsent,
  type BbToolsRpc,
} from "./tool-bridge.js";

function unavailable(rpcID = BB_TOOLS_RPC): Error {
  const message = `RPC is unavailable: ${rpcID}`;
  return new Error(message, { cause: { _tag: "RpcError", type: "rpc.unavailable", message } });
}

describe("bb tools RPC client", () => {
  it("treats rpc.unavailable as an absent companion, including a wrapped cause", async () => {
    const wrapped = new Error("transport", { cause: unavailable() });
    expect(isCompanionAbsent(unavailable())).toBe(true);
    expect(isCompanionAbsent(wrapped)).toBe(true);
    expect(isCompanionAbsent(new Error("socket hang up"))).toBe(false);
    expect(classifyBbToolsRpcError(unavailable())).toBe("absent");
    expect(classifyBbToolsRpcError(new Error("boom"))).toBe("failed");
    expect(() => classifyBbToolsRpcError(new OpenCodeUnauthenticatedError("no"))).toThrow(
      OpenCodeUnauthenticatedError,
    );

    const client = createBbToolsClient(async () => {
      throw unavailable();
    });
    await expect(client.hello()).resolves.toEqual({ kind: "absent" });
  });

  it("rejects a hello that is not the supported protocol and parses a matching one", async () => {
    const responses: unknown[] = [
      { protocol: "bb.tools.v1", version: 99, generation: "g" },
      { protocol: "other", version: 1, generation: "g" },
      { nope: true },
      { protocol: "bb.tools.v1", version: 1, generation: "gen-1", features: { richFailures: false } },
    ];
    const client = createBbToolsClient(async () => responses.shift());
    await expect(client.hello()).resolves.toMatchObject({ kind: "rejected" });
    await expect(client.hello()).resolves.toMatchObject({ kind: "rejected" });
    await expect(client.hello()).resolves.toMatchObject({
      kind: "rejected",
      message: expect.stringContaining("did not match bb.tools.v1"),
    });
    await expect(client.hello()).resolves.toEqual({ kind: "ok", generation: "gen-1" });
  });

  it("validates every method output and classifies unbound, conflict, and timeout", async () => {
    const calls: string[] = [];
    const rpc: BbToolsRpc = async (_id, method) => {
      calls.push(method);
      if (method === "status") return { bound: true, generation: "g", epoch: 2 };
      if (method === "attach") {
        return { bindingID: "b1", capability: "cap", generation: "g", epoch: 2 };
      }
      if (method === "pending") return { calls: [], settled: [] };
      if (method === "claim") return {};
      if (method === "configure" || method === "reject" || method === "detach") return {};
      if (method === "result") throw new Error("result conflicts with the settled receipt");
      return {};
    };
    const client = createBbToolsClient(rpc);
    await expect(client.status("cap")).resolves.toEqual({ bound: true, generation: "g", epoch: 2 });
    await expect(
      client.attach({ sessionID: "ses", disallowedTools: [], tools: [] }),
    ).resolves.toMatchObject({ capability: "cap" });
    await expect(client.pending({ capability: "cap", acknowledged: [] })).resolves.toEqual({
      calls: [],
      settled: [],
    });
    await expect(client.claim({ capability: "cap", key: "k" })).resolves.toBeUndefined();
    await expect(client.configure({ capability: "cap", disallowedTools: ["bb_echo"] })).resolves.toBeUndefined();
    await expect(client.result({ capability: "cap", key: "k", success: true, contentItems: [] })).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(calls).toEqual(["status", "attach", "pending", "claim", "configure", "result"]);

    const unbound = createBbToolsClient(async () => {
      throw new Error("unknown capability");
    });
    await expect(unbound.pending({ capability: "cap", acknowledged: [] })).rejects.toBeInstanceOf(BbToolsRpcError);
    await expect(unbound.pending({ capability: "cap", acknowledged: [] })).rejects.toMatchObject({ kind: "unbound" });

    const slow = createBbToolsClient(async () => new Promise(() => undefined));
    await expect(slow.detach({ capability: "cap" }, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("treats an rpc.unavailable cause as absent and ignores an unrelated message", () => {
    expect(isCompanionAbsent(unavailable("other.rpc"))).toBe(true);
    expect(isCompanionAbsent(new Error("RPC is unavailable: other.rpc"))).toBe(false);
  });
});
