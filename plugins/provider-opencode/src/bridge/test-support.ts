import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcId,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOpenCodeBridge, type OpenCodeBridgeDeps } from "./bridge.js";
import {
  createFakeOpenCodeRuntime,
  type CreateFakeOpenCodeRuntimeOptions,
  type FakeOpenCodeRuntime,
  type OpenCodeRuntime,
} from "../runtime/index.js";

export const FULL_PERMISSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

export interface StartOpenCodeBridgeHarnessOptions {
  prefix?: string;
  initialize?: boolean;
  scriptTurns?: boolean;
  runtime?: CreateFakeOpenCodeRuntimeOptions;
  fake?: FakeOpenCodeRuntime;
  wrapRuntime?: (fake: FakeOpenCodeRuntime) => OpenCodeRuntime;
  bridge?: Omit<OpenCodeBridgeDeps, "createRuntime" | "warn">;
  dataDir?: string;
}

export interface OpenCodeBridgeHarness {
  workspaceDir: string;
  fake: FakeOpenCodeRuntime;
  rpc: BridgeJsonRpcTestHarness;
  warnings: string[];
  closeAll(): Promise<void>;
  handleLine: (line: string) => void;
  takeMessages: () => BridgeJsonRpcOutputMessage[];
  request(
    id: BridgeJsonRpcId,
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  startThread(
    threadId: string,
    extra?: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  deltasOf(threadId: string): Record<string, unknown>[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  injectTurnDeltas(threadId: string, deltas: Record<string, unknown>[]): Promise<void>;
  injectResync(threadId: string): Promise<void>;
  teardown(): Promise<void>;
}

export async function startOpenCodeBridgeHarness(
  options: StartOpenCodeBridgeHarnessOptions = {},
): Promise<OpenCodeBridgeHarness> {
  const workspaceDir = mkdtempSync(
    join(tmpdir(), options.prefix ?? "bb-opencode-bridge-"),
  );
  const fake =
    options.fake ??
    createFakeOpenCodeRuntime({
      ...options.runtime,
      scriptTurns: options.scriptTurns === true,
    });
  const runtime = options.wrapRuntime?.(fake) ?? fake;
  const warnings: string[] = [];
  const bridge = createOpenCodeBridge({
    ...options.bridge,
    createRuntime: async () => runtime,
    warn: (message) => {
      warnings.push(message);
    },
  });
  if (options.dataDir !== undefined) {
    bridge.experimental_providerBridge.start?.({
      pluginId: "provider-opencode",
      dataDir: options.dataDir,
      tempDir: options.dataDir,
    });
  }
  const rpc = createBridgeJsonRpcTestHarness(bridge.handleLine);
  let requestId = 1;

  function deltasOf(threadId: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const message of rpc.messages) {
      if (message.method !== "thread/delta") continue;
      const params = message.params;
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        continue;
      }
      if (params.threadId !== threadId || !Array.isArray(params.deltas)) continue;
      for (const delta of params.deltas) {
        if (delta !== null && typeof delta === "object" && !Array.isArray(delta)) {
          out.push(delta);
        }
      }
    }
    return out;
  }

  const harness: OpenCodeBridgeHarness = {
    workspaceDir,
    fake,
    rpc,
    warnings,
    closeAll: () => bridge.closeAll(),
    handleLine: bridge.handleLine,
    takeMessages: rpc.takeMessages,
    async request(id, method, params) {
      rpc.sendRequest(id, method, params);
      return rpc.waitForResponse(id);
    },
    async startThread(threadId, extra) {
      const id = requestId;
      requestId += 1;
      return harness.request(id, "thread/start", {
        threadId,
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        ...(extra ?? {}),
      });
    },
    deltasOf,
    injectTurnDeltas: (threadId, deltas) => bridge.injectTurnDeltas(threadId, deltas as never),
    injectResync: (threadId) => bridge.injectResync(threadId),
    async waitFor(predicate, what) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await rpc.flushWork();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      throw new Error(`Timed out waiting for ${what}`);
    },
    async teardown() {
      await bridge.closeAll();
      rpc.restore();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };

  if (options.initialize !== false) {
    const initialize = await harness.request(requestId, "initialize", {
      protocolVersion: 2,
      client: { name: "test", version: "1" },
      grammarVersions: [3, 3],
    });
    requestId += 1;
    if (initialize.error !== undefined) {
      await harness.teardown();
      throw new Error(`initialize failed: ${JSON.stringify(initialize.error)}`);
    }
  }

  return harness;
}
