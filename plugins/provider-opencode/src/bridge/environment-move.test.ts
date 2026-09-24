import { chmod, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodeRuntime, SessionHandle } from "../runtime/index.js";
import { startOpenCodeBridgeHarness, FULL_PERMISSION_OPTIONS } from "./test-support.js";

const echoTool = {
  name: "bb_echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function providerThreadId(response: { result?: unknown }): string {
  const result = response.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("missing provider thread id");
  }
  const id = (result as { providerThreadId?: unknown }).providerThreadId;
  if (typeof id !== "string") throw new Error("missing provider thread id");
  return id;
}

function wrapAttach(
  runtime: OpenCodeRuntime,
  failAttach: () => boolean,
): OpenCodeRuntime {
  const wrap = (handle: SessionHandle): SessionHandle => ({
    ...handle,
    move: async (directory) => wrap(await handle.move(directory)),
    rpc: async (rpcID, method, input) => {
      if (method === "hello") return { protocol: "bb.tools.v1", version: 1, generation: "g" };
      if (method === "status") return { bound: true, generation: "g", epoch: 1 };
      if (method === "attach") {
        if (failAttach()) throw new Error("attach failed");
        return { bindingID: "b1", capability: "cap", generation: "g", epoch: 1 };
      }
      if (method === "pending") return { calls: [], settled: [] };
      if (method === "configure" || method === "detach" || method === "reject" || method === "result") return {};
      return handle.rpc(rpcID, method, input);
    },
  });
  return {
    ...runtime,
    createSession: async (input) => wrap(await runtime.createSession(input)),
    openSession: async (id) => wrap(await runtime.openSession(id)),
  };
}

async function waitForOwnersFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const { access } = await import("node:fs/promises");
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`owners file was not written: ${path}`);
}

describe("environment directory migration", () => {
  it("moves an owned session to the resumed directory and runs the next turn there", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-env-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const harness = await startOpenCodeBridgeHarness({
      dataDir: join(root, "data"),
      scriptTurns: true,
    });
    try {
      const started = await harness.request(20, "thread/start", {
        threadId: "thr_move",
        cwd: dirA,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(started.error).toBeUndefined();
      const providerThreadId = (started.result as { providerThreadId: string }).providerThreadId;
      const resumed = await harness.request(21, "thread/resume", {
        threadId: "thr_move",
        cwd: dirB,
        providerThreadId,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(resumed.error).toBeUndefined();
      expect(harness.fake.calls.moves).toEqual([{ sessionID: providerThreadId, directory: dirB }]);
      const info = await (await harness.fake.openSession(providerThreadId)).info();
      expect(info.location.directory).toBe(dirB);
      const turned = await harness.request(22, "turn/start", {
        threadId: "thr_move",
        providerThreadId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: "after move", mentions: [] }],
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(turned.error).toBeUndefined();
      expect(harness.fake.calls.promptDirectories).toEqual([
        { sessionID: providerThreadId, directory: dirB },
      ]);
    } finally {
      await harness.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an unrelated session instead of moving it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-env-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const harness = await startOpenCodeBridgeHarness({ dataDir: join(root, "data") });
    try {
      const started = await harness.request(30, "thread/start", {
        threadId: "thr_owner",
        cwd: dirA,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      const providerThreadId = (started.result as { providerThreadId: string }).providerThreadId;
      const foreign = await harness.request(31, "thread/resume", {
        threadId: "thr_other",
        cwd: dirB,
        providerThreadId,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(foreign.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(foreign.error?.message).toContain("belongs to thread thr_owner");
      expect(harness.fake.calls.moves).toEqual([]);
      const missingOwner = await harness.request(32, "thread/resume", {
        threadId: "thr_owner",
        cwd: dirA,
        providerThreadId: "ses_missing",
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(missingOwner.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
    } finally {
      await harness.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when reattach fails after the move and refuses a resume back to A", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-env-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    let failAttach = false;
    const harness = await startOpenCodeBridgeHarness({
      dataDir: join(root, "data"),
      wrapRuntime: (fake) => wrapAttach(fake, () => failAttach),
    });
    try {
      const started = await harness.request(40, "thread/start", {
        threadId: "thr_reattach",
        cwd: dirA,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [echoTool],
      });
      expect(started.error).toBeUndefined();
      const id = providerThreadId(started);
      failAttach = true;
      const moved = await harness.request(41, "thread/resume", {
        threadId: "thr_reattach",
        cwd: dirB,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [echoTool],
      });
      expect(moved.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(moved.error?.message).toContain("could not be restored");
      expect(moved.result).toBeUndefined();
      expect(harness.fake.calls.moves).toEqual([{ sessionID: id, directory: dirB }]);
      const stillLive = await harness.request(42, "turn/start", {
        threadId: "thr_reattach",
        providerThreadId: id,
        clientRequestId: "creq_23456789ac",
        input: [{ type: "text", text: "should not run", mentions: [] }],
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(stillLive.error?.message).toContain("No active OpenCode session");
      const back = await harness.request(43, "thread/resume", {
        threadId: "thr_reattach",
        cwd: dirA,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [echoTool],
      });
      expect(back.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(back.error?.message).toContain(`moving to ${dirB}`);
      expect(harness.fake.calls.moves).toEqual([{ sessionID: id, directory: dirB }]);
      failAttach = false;
      const finished = await harness.request(44, "thread/resume", {
        threadId: "thr_reattach",
        cwd: dirB,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [echoTool],
      });
      expect(finished.error).toBeUndefined();
      expect(harness.fake.calls.moves).toEqual([{ sessionID: id, directory: dirB }]);
      const info = await (await harness.fake.openSession(id)).info();
      expect(info.location.directory).toBe(dirB);
    } finally {
      await harness.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses resume to A when the native session is already at B and the owner cwd still matches A", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-env-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const harness = await startOpenCodeBridgeHarness({ dataDir: join(root, "data") });
    try {
      const started = await harness.request(50, "thread/start", {
        threadId: "thr_stale_owner",
        cwd: dirA,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      const id = providerThreadId(started);
      await (await harness.fake.openSession(id)).move(dirB);
      const back = await harness.request(51, "thread/resume", {
        threadId: "thr_stale_owner",
        cwd: dirA,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(back.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(back.error?.message).toContain(`bound to ${dirB}`);
      expect(harness.fake.calls.moves).toEqual([{ sessionID: id, directory: dirB }]);
    } finally {
      await harness.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the resume when the migrated owner cannot be saved and does not announce", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-oc-env-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const harness = await startOpenCodeBridgeHarness({ dataDir });
    try {
      const started = await harness.request(60, "thread/start", {
        threadId: "thr_owner_write",
        cwd: dirA,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(started.error).toBeUndefined();
      const id = providerThreadId(started);
      await waitForOwnersFile(join(dataDir, "opencode-session-owners.json"));
      await chmod(dataDir, 0o555);
      const resumed = await harness.request(61, "thread/resume", {
        threadId: "thr_owner_write",
        cwd: dirB,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(resumed.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE);
      expect(resumed.error?.message).toContain("could not be saved");
      expect(resumed.result).toBeUndefined();
      await chmod(dataDir, 0o755);
      const finished = await harness.request(62, "thread/resume", {
        threadId: "thr_owner_write",
        cwd: dirB,
        providerThreadId: id,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
      });
      expect(finished.error).toBeUndefined();
      expect(finished.result).toMatchObject({ providerThreadId: id, sessionRestorable: true });
    } finally {
      await chmod(dataDir, 0o755).catch(() => undefined);
      await harness.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
