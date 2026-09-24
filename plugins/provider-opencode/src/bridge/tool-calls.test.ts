import { describe, expect, it } from "vitest";
import { bbToolsRequiredSetupMessage } from "../bb-tools-required.js";
import type { SessionHandle } from "../runtime/index.js";
import { absentCompanionWarningDetails, ABSENT_COMPANION_WARNING_SUMMARY } from "../strings.js";
import { BbToolsSetupError, createBbToolCalls, type BbToolHost } from "./tool-calls.js";

function host(partial: Partial<BbToolHost> & Pick<BbToolHost, "handle">): BbToolHost {
  return {
    threadId: "thr",
    closed: false,
    turnOpen: true,
    busy: true,
    disallowedTools: [],
    bbToolsRequired: false,
    appId: async () => "opencode",
    takeoverCapability: () => undefined,
    rememberCapability: async () => undefined,
    secrets: () => [],
    listPlugins: async () => [],
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
      if (method === "status") {
        return { bound: true, generation: "g", epoch: 1, catalogDigest: "a".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        return {
          bindingID: "b",
          capability: "cap",
          generation: "g",
          epoch: 1,
          catalogDigest: "a".repeat(64),
          ownerLeaseMs: 30_000,
        };
      }
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

  it("fails a required turn when the companion is absent and warns otherwise", async () => {
    const sent: unknown[] = [];
    const absent = async () => {
      throw new Error("RPC is unavailable: bb.tools.v1", {
        cause: { type: "rpc.unavailable", message: "RPC is unavailable: bb.tools.v1" },
      });
    };
    const handle = { id: "ses", location: { directory: "/a" }, rpc: absent } as unknown as SessionHandle;
    const required = createBbToolCalls().bind(
      host({
        handle,
        bbToolsRequired: true,
        appId: async () => "shuvcode",
        send: (message) => sent.push(message),
      }),
    );
    await required.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    await expect(required.ensure()).rejects.toThrow(BbToolsSetupError);
    await expect(required.ensure()).rejects.toThrow(bbToolsRequiredSetupMessage("shuvcode"));
    expect(sent).toEqual([]);

    const optional = createBbToolCalls().bind(
      host({
        handle,
        bbToolsRequired: false,
        appId: async () => "opencode",
        send: (message) => sent.push(message),
      }),
    );
    await optional.attach([{ name: "bb_lookup", description: "lookup", inputSchema: { type: "object" } }]);
    expect(JSON.stringify(sent)).toContain(ABSENT_COMPANION_WARNING_SUMMARY);
    expect(JSON.stringify(sent)).toContain(
      absentCompanionWarningDetails({ toolNames: ["bb_lookup"], appId: "opencode" }),
    );
  });

  it("waits out owner_active up to the lease, then presents takeover on the retry", async () => {
    const calls: unknown[] = [];
    let attaches = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method, input) => {
      calls.push({ method, input });
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        return { bound: true, generation: "g", epoch: 2, catalogDigest: "a".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        attaches += 1;
        if (attaches === 1) {
          throw new Error("owner lease is active", {
            cause: { type: "owner_active", message: "owner lease is active", data: { retryAfterMs: 25 } },
          });
        }
        return {
          bindingID: "b2",
          capability: "cap-new",
          generation: "g",
          epoch: 2,
          catalogDigest: "a".repeat(64),
          ownerLeaseMs: 30_000,
        };
      }
      return {};
    };
    const waits: number[] = [];
    const saved: string[] = [];
    const session = createBbToolCalls({
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        takeoverCapability: () => "cap-old",
        rememberCapability: async (capability) => {
          saved.push(capability);
        },
      }),
    );
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    expect(waits).toEqual([25]);
    expect(saved.at(-1)).toBe("cap-new");
    expect(session.capability()).toBe("cap-new");
    const attach = calls.find(
      (item): item is { method: string; input: { takeover?: { capability: string }; bbThreadId?: string } } =>
        typeof item === "object" && item !== null && (item as { method?: string }).method === "attach",
    );
    expect(attach?.input.takeover).toEqual({ capability: "cap-old" });
    expect(attach?.input.bbThreadId).toBe("thr");
  });

  it("fails owner_active when the retry would exceed the lease", async () => {
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "attach") {
        throw new Error("owner lease is active", {
          cause: { type: "owner_active", message: "owner lease is active", data: { retryAfterMs: 40_000 } },
        });
      }
      return {};
    };
    const session = createBbToolCalls({ sleep: async () => undefined }).bind(
      host({ handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle }),
    );
    await expect(
      session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }], "turn"),
    ).rejects.toThrow(/owner lease is active/);
  });

  it("drops invalid tools once, warns, and retries attach without them", async () => {
    const sent: unknown[] = [];
    const catalogs: string[][] = [];
    let attaches = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method, input) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        return { bound: true, generation: "g", epoch: 1, catalogDigest: "b".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        attaches += 1;
        const tools = (input as { tools?: Array<{ name: string }> }).tools ?? [];
        catalogs.push(tools.map((tool) => tool.name));
        if (attaches === 1) {
          throw new Error("bad name", {
            cause: {
              type: "invalid",
              message: "tools[1].name is not a valid tool name",
              data: {
                reason: "name",
                tools: [{ tool: "bad name", reason: "name", detail: "tools[1].name is not a valid tool name" }],
              },
            },
          });
        }
        return {
          bindingID: "b",
          capability: "cap",
          generation: "g",
          epoch: 1,
          catalogDigest: "b".repeat(64),
          ownerLeaseMs: 30_000,
        };
      }
      if (method === "pending") return { calls: [], settled: [] };
      return {};
    };
    const session = createBbToolCalls().bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        send: (message) => sent.push(message),
      }),
    );
    await session.attach(
      [
        { name: "bb_echo", description: "echo", inputSchema: { type: "object" } },
        { name: "bad name", description: "nope", inputSchema: { type: "object" } },
      ],
      "turn",
    );
    expect(catalogs).toEqual([["bb_echo", "bad name"], ["bb_echo"]]);
    expect(JSON.stringify(sent)).toContain("Dropped invalid bb tools");
    expect(JSON.stringify(sent)).toContain("bad name (name: tools[1].name is not a valid tool name)");
  });

  it("stops result delivery on too_large instead of retrying", async () => {
    let results = 0;
    const sent: Array<{ id?: string | number; method?: string }> = [];
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        return { bound: true, generation: "g", epoch: 1, catalogDigest: "c".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        return {
          bindingID: "b",
          capability: "cap",
          generation: "g",
          epoch: 1,
          catalogDigest: "c".repeat(64),
          ownerLeaseMs: 30_000,
        };
      }
      if (method === "pending") {
        return {
          calls: [
            {
              key: "k1",
              sessionID: "ses",
              messageID: "msg",
              callID: "call",
              tool: "bb_echo",
              arguments: {},
              state: "pending",
              origin: { rootSessionID: "ses", rootMessageID: "msg" },
            },
          ],
          settled: [],
        };
      }
      if (method === "claim") return { key: "k1" };
      if (method === "result") {
        results += 1;
        throw new Error("bb tool result exceeded the companion limit of 12 bytes", {
          cause: {
            type: "too_large",
            message: "bb tool result exceeded the companion limit of 12 bytes",
            data: { limit: 12 },
          },
        });
      }
      return {};
    };
    const handle = { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle;
    const calls = createBbToolCalls({ pollMs: 15 });
    const session = calls.bind(
      host({
        handle,
        turnOpen: true,
        busy: true,
        send: (message) => {
          if (typeof message === "object" && message !== null) sent.push(message as { id?: string | number; method?: string });
        },
      }),
    );
    session.noteAssistantMessage("msg", "exec:ses:1");
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    session.ensurePoll();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const reverse = sent.find((message) => message.method === "item/tool/call");
    expect(reverse?.id).toEqual(expect.any(String));
    expect(
      calls.handleResponse({
        id: reverse?.id ?? "",
        result: { success: true, contentItems: [{ type: "inputText", text: "x".repeat(40) }] },
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(results).toBe(1);
  });

  it("fails attachment when hello reports more than one companion", async () => {
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") {
        return { protocol: "bb.tools.v1", version: 1, generation: "g", instances: 2, versions: { min: 1, max: 1 } };
      }
      return {};
    };
    const session = createBbToolCalls().bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        listPlugins: async () => ({
          data: [
            { id: "bb.tools.aaa", source: { type: "package", target: "opencode-bb-tools" }, state: { status: "active" } },
            {
              id: "bb.tools.bbb",
              source: { type: "package", target: "github:shuv1337/opencode-bb-tools" },
              state: { status: "active" },
            },
          ],
        }),
      }),
    );
    await expect(
      session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }], "turn"),
    ).rejects.toThrow(/Remove every extra spec/);
  });

  it("renews the owner lease with status between turns", async () => {
    let statuses = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        statuses += 1;
        return { bound: true, generation: "g", epoch: 1, catalogDigest: "d".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        return {
          bindingID: "b",
          capability: "cap",
          generation: "g",
          epoch: 1,
          catalogDigest: "d".repeat(64),
          ownerLeaseMs: 30,
        };
      }
      return {};
    };
    const session = createBbToolCalls().bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        turnOpen: false,
        busy: false,
      }),
    );
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    const afterAttach = statuses;
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(statuses).toBeGreaterThan(afterAttach);
    session.close();
  });

  it("keeps only one heartbeat status in flight while a renewal is stalled", async () => {
    let statuses = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        statuses += 1;
        if (statuses === 1) {
          return { bound: true, generation: "g", epoch: 1, catalogDigest: "d".repeat(64), leaseExpiresAt: 1 };
        }
        return new Promise(() => undefined);
      }
      if (method === "attach") {
        return {
          bindingID: "b",
          capability: "cap",
          generation: "g",
          epoch: 1,
          catalogDigest: "d".repeat(64),
          ownerLeaseMs: 30,
        };
      }
      return {};
    };
    const session = createBbToolCalls({ leaseStatusTimeoutMs: 80 }).bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        turnOpen: false,
        busy: false,
      }),
    );
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(statuses).toBe(2);
    session.close();
  });

  it("stops the heartbeat when status is unbound and reattaches on the next turn", async () => {
    let statuses = 0;
    let attaches = 0;
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") {
        statuses += 1;
        if (statuses === 2) return { bound: false, generation: "g" };
        return { bound: true, generation: "g", epoch: Math.max(attaches, 1), catalogDigest: "d".repeat(64), leaseExpiresAt: 1 };
      }
      if (method === "attach") {
        attaches += 1;
        return {
          bindingID: `b${attaches}`,
          capability: `cap-${attaches}`,
          generation: "g",
          epoch: attaches,
          catalogDigest: "d".repeat(64),
          ownerLeaseMs: 30,
        };
      }
      return {};
    };
    const session = createBbToolCalls().bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        turnOpen: false,
        busy: false,
      }),
    );
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopped = statuses;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(statuses).toBe(stopped);
    await session.ensure();
    expect(attaches).toBe(2);
    session.close();
  });

  it("redacts a capability echoed by an upstream attach error", async () => {
    const secret = "cap-secret-value";
    const sent: unknown[] = [];
    const rpc: SessionHandle["rpc"] = async (_id, method) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "attach") throw new Error(`attach failed for ${secret} {"capability":"${secret}","takeover":{"capability":"${secret}"}}`);
      return {};
    };
    const session = createBbToolCalls().bind(
      host({
        handle: { id: "ses", location: { directory: "/a" }, rpc } as SessionHandle,
        secrets: () => [secret],
        send: (message) => sent.push(message),
      }),
    );
    await session.attach([{ name: "bb_echo", description: "echo", inputSchema: { type: "object" } }]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(secret);
    expect(wire).toContain("[redacted]");
  });
});
