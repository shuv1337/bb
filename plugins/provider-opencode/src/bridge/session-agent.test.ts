import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOpenCodeBridge } from "./bridge.js";
import {
  createFakeOpenCodeRuntime,
  type CreateSessionInput,
  type OpenCodeAgent,
  type OpenCodeRuntime,
} from "../runtime/index.js";

const AGENTS: OpenCodeAgent[] = [
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "reviewer", name: "Reviewer", mode: "primary", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
];

const CWD = "/tmp/opencode-agent";

function executionOptions(agent: string | null): BridgeJsonRpcObject {
  return {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    providerOptions: { agent },
  };
}

function providerThreadId(response: BridgeJsonRpcOutputMessage): string {
  const result = response.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("thread/start did not return a provider thread id");
  }
  const id = result.providerThreadId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("thread/start did not return a provider thread id");
  }
  return id;
}

async function withAgents(
  run: (tools: {
    request: (
      method: string,
      params: BridgeJsonRpcObject,
    ) => Promise<BridgeJsonRpcOutputMessage>;
    created: CreateSessionInput[];
    agentOf: (sessionId: string) => Promise<string | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const created: CreateSessionInput[] = [];
  const inner = createFakeOpenCodeRuntime({ agents: AGENTS });
  const runtime: OpenCodeRuntime = {
    ...inner,
    createSession: (input) => {
      created.push(input);
      return inner.createSession(input);
    },
  };
  const bridge = createOpenCodeBridge({
    createRuntime: async () => runtime,
  });
  const rpc = createBridgeJsonRpcTestHarness(bridge.handleLine);
  let nextId = 0;
  try {
    await run({
      created,
      async request(method, params) {
        nextId += 1;
        const id = nextId;
        rpc.sendRequest(id, method, params);
        return rpc.waitForResponse(id);
      },
      async agentOf(sessionId) {
        const handle = await inner.openSession(sessionId);
        return (await handle.info()).agent;
      },
    });
  } finally {
    await bridge.closeAll();
    rpc.restore();
  }
}

describe("OpenCode defaultAgent at thread start", () => {
  it("fails an unknown agent by name and does not create a build session", async () => {
    await withAgents(async ({ request, created }) => {
      const response = await request("thread/start", {
        threadId: "thr_unknown",
        cwd: CWD,
        instructionMode: "append",
        options: executionOptions("ghost"),
      });
      expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
      expect(response.error?.message).toBe('Unknown OpenCode agent "ghost"');
      expect(created).toEqual([]);
    });
  });

  it("rejects a non-selectable agent instead of falling back to build", async () => {
    await withAgents(async ({ request, created }) => {
      const response = await request("thread/start", {
        threadId: "thr_subagent",
        cwd: CWD,
        instructionMode: "append",
        options: executionOptions("explore"),
      });
      expect(response.error?.message).toBe('Unknown OpenCode agent "explore"');
      expect(created.map((input) => input.agent)).toEqual([]);
    });
  });

  it("passes a listed primary agent through and omits an empty setting", async () => {
    await withAgents(async ({ request, created }) => {
      const named = await request("thread/start", {
        threadId: "thr_reviewer",
        cwd: CWD,
        instructionMode: "append",
        options: executionOptions("reviewer"),
      });
      expect(named.error).toBeUndefined();
      expect(providerThreadId(named).length).toBeGreaterThan(0);
      const omitted = await request("thread/start", {
        threadId: "thr_default",
        cwd: CWD,
        instructionMode: "append",
        options: executionOptions(null),
      });
      expect(omitted.error).toBeUndefined();
      expect(created.map((input) => input.agent)).toEqual(["reviewer", undefined]);
    });
  });

  it("treats a leftover plan prompt as the default agent instead of switching to plan", async () => {
    await withAgents(async ({ request, created, agentOf }) => {
      const started = await request("thread/start", {
        threadId: "thr_plan_ignored",
        cwd: CWD,
        instructionMode: "append",
        options: {
          ...executionOptions("plan"),
          promptMode: "plan",
        },
      });
      expect(started.error).toBeUndefined();
      expect(created.map((input) => input.agent)).toEqual([undefined]);
      expect(await agentOf(providerThreadId(started))).toBeUndefined();
    });
  });

  it("does not switch a plan session to build when leaving plan onto an unknown agent", async () => {
    await withAgents(async ({ request, created, agentOf }) => {
      const started = await request("thread/start", {
        threadId: "thr_plan",
        cwd: CWD,
        instructionMode: "append",
        options: executionOptions("plan"),
      });
      expect(started.error).toBeUndefined();
      const sessionId = providerThreadId(started);
      const left = await request("turn/start", {
        threadId: "thr_plan",
        providerThreadId: sessionId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: "leave plan", mentions: [] }],
        options: executionOptions("explore"),
      });
      expect(left.error?.message).toBe('Unknown OpenCode agent "explore"');
      expect(created.map((input) => input.agent)).toEqual(["plan"]);
      expect(await agentOf(sessionId)).toBe("plan");
    });
  });

  it("fails resume of a missing session instead of creating one", async () => {
    await withAgents(async ({ request, created }) => {
      const response = await request("thread/resume", {
        threadId: "thr_missing",
        cwd: CWD,
        instructionMode: "append",
        providerThreadId: "ses_missing",
        options: executionOptions(null),
      });
      expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(created).toEqual([]);
    });
  });
});
