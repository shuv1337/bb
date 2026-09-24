import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { startOpenCodeBridgeHarness, FULL_PERMISSION_OPTIONS } from "./test-support.js";

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
});
