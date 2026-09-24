import { mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  experimental_BridgeRecoveryError,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  isApprovalPendingInteractionResolution,
  isUserQuestionPendingInteractionResolution,
  modelListParamsSchema,
  pendingInteractionResolutionSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type DynamicTool,
  type InitializeResult,
  type PendingInteractionPayload,
  type ProviderBridgeContext,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { toAvailableModels } from "../models.js";
import { disallowedToolRules } from "../permissions.js";
import { OPENCODE_SIGN_IN_HINT } from "../strings.js";
import { createOpenCodeDeltaTranslator, nativeTerminalsFromEvents } from "../delta-translation.js";
import {
  openCodeFormPage,
  openCodeFormPageAnswer,
  openCodeFormQuestionPayload,
  type OpenCodeFormField,
  type OpenCodeFormValue,
} from "../forms.js";
import {
  classifyOpenCodeTurn,
  knobsFromExecution,
  mapApprovalToOpenCodeReply,
  sessionTitleForThread,
  type AppliedSessionKnobs,
} from "../session-params.js";
import {
  assertSelectableAgentId,
  createOpenCodeRuntime,
  OpenCodeUnauthenticatedError,
  type OpenCodeModel,
  type OpenCodeNativeEvent,
  type OpenCodePermissionRule,
  type OpenCodeRuntime,
  type RuntimeSessionEvent,
  type SessionHandle,
} from "../runtime/index.js";
import {
  getOpenCodeProviderHealth,
  getOpenCodeProviderInstallationRun,
  getOpenCodeProviderInstallationStatus,
} from "./provider-maintenance.js";
import {
  BB_TOOL_CALL_CANCELLED,
  BB_TOOL_OUTCOME_UNKNOWN,
  BbToolsSetupError,
  createBbToolCalls,
  type BbToolHost,
  type BbToolSession,
} from "./tool-calls.js";
import { BB_TOOLS_CONTROL_EVENT, redactCompanionSecrets } from "../runtime/tool-bridge.js";

export { BB_TOOL_CALL_CANCELLED, BB_TOOL_OUTCOME_UNKNOWN };
export const UNOPENED_DISPATCH_GRACE_MS = 250;
const INTERRUPT_SETTLEMENT_TIMEOUT_MS = 5_000;
const RESUBSCRIBE_BACKOFF_INITIAL_MS = 250;
const RESUBSCRIBE_BACKOFF_MAX_MS = 8_000;

const PROVIDER_ACTIVITY = new Set([
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.execution.started",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.step.started",
  "session.tool.input.started",
  "session.tool.called",
]);

const commandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("initialize"), params: initializeParamsSchema }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({ method: z.literal("thread/start"), params: threadStartParamsSchema }),
  z.object({ method: z.literal("thread/resume"), params: threadResumeParamsSchema }),
  z.object({ method: z.literal("thread/fork"), params: threadForkParamsSchema }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({ method: z.literal("thread/stop"), params: threadStopParamsSchema }),
  z.object({ method: z.literal("thread/discard"), params: threadDiscardParamsSchema }),
  z.object({ method: z.literal("thread/name/set"), params: threadNameSetParamsSchema }),
]);

type OpenCodeCommand = z.infer<typeof commandSchema>;
const commandMethods = commandSchema.options.map((option) => option.shape.method.value);

type DecodedRequest =
  | { kind: "request"; request: OpenCodeCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | { kind: "invalid-params"; id: string | number; method: string; issues: string }
  | { kind: "ignored" };

export interface OpenCodeBridgeDeps {
  createRuntime?: () => Promise<OpenCodeRuntime>;
  interruptSettlementTimeoutMs?: number;
  resubscribeBackoffMs?: { initial: number; max: number };
  warn?: (message: string) => void;
}

type OwnerRecord = {
  threadId: string;
  cwd: string;
  pendingDirectory?: string;
  capability?: string;
};

interface PendingForm {
  fields: OpenCodeFormField[];
  offset: number;
  answer: Record<string, OpenCodeFormValue>;
}

type PendingInteraction =
  | {
      kind: "permission";
      requestID: string;
      persistApprovals: boolean;
      handle: SessionHandle;
      threadId: string;
    }
  | {
      kind: "form";
      requestID: string;
      form: PendingForm;
      handle: SessionHandle;
      threadId: string;
    };

interface ThreadSession {
  threadId: string;
  handle: SessionHandle;
  cwd: string;
  abort: AbortController;
  closed: boolean;
  persistApprovals: boolean;
  busy: boolean;
  work: Promise<void>;
  childHandles: Map<string, SessionHandle>;
  catalog: OpenCodeModel[];
  disallowedTools: readonly string[];
  bbToolsRequired: boolean;
  busyChildren: Set<string>;
  unopenableChildren: Set<string>;
  settleWaiters: Set<(settled: boolean) => void>;
  turnOpen: boolean;
  liveProviderTurnId: string | undefined;
  deferredResyncMessages: Parameters<ReturnType<typeof createOpenCodeDeltaTranslator>["reconcileAfterResync"]>[1] | undefined;
  pendingAccepts: Array<{
    clientRequestId: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
  dispatches: Set<InFlightDispatch>;
  tools: BbToolSession;
  bbTools: readonly DynamicTool[] | undefined;
  activityRetryUsed: boolean;
  activityRetryTimer: ReturnType<typeof setTimeout> | undefined;
}

interface InFlightDispatch {
  openedTurnId: string | undefined;
}

function decodeRequest(raw: unknown): DecodedRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = commandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return { kind: "request", request: { ...command.data, id: envelope.data.id } };
  }
  if (!(commandMethods as readonly string[]).includes(envelope.data.method)) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues.map((issue) => issue.message).join("; "),
  };
}

function stringListParam(params: object, key: string): string[] | undefined {
  const value = (params as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
  return value;
}

function bbThreadIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.bbThreadId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createOpenCodeBridge(deps: OpenCodeBridgeDeps = {}) {
  const bridgeIo = createBridgeIo();
  const knownCapabilities = new Set<string>();
  function scrub<T>(value: T): T {
    return redactCompanionSecrets(value, [...knownCapabilities]);
  }
  function noteCapability(value: string | undefined): void {
    if (value !== undefined && value.length > 0) knownCapabilities.add(value);
  }
  const send: typeof bridgeIo.send = (message) => {
    bridgeIo.send(scrub(message));
  };
  const sendResult: typeof bridgeIo.sendResult = (id, result) => {
    bridgeIo.sendResult(id, scrub(result));
  };
  const sendError: typeof bridgeIo.sendError = (id, code, message, data) => {
    bridgeIo.sendError(
      id,
      code,
      scrub(message),
      data === undefined ? undefined : scrub(data),
    );
  };
  const translator = createOpenCodeDeltaTranslator();
  const sessions = new Map<string, ThreadSession>();
  const sessionsByProviderId = new Map<string, ThreadSession>();
  const pendingInteractions = new Map<string, PendingInteraction>();
  let ignoredNativeTypes = new Set<string>();
  const replyingInteractions = new Set<string>();
  const owners = new Map<string, OwnerRecord>();
  let runtimePromise: Promise<OpenCodeRuntime> | null = null;
  let runtimeRefresh: Promise<void> | null = null;
  let ownersPath: string | null = null;
  let ownersWrite: Promise<void> = Promise.resolve();
  let interactionSerial = 0;
  let zeroWorkSerial = 0;
  let closed = false;
  const interruptSettlementTimeoutMs =
    deps.interruptSettlementTimeoutMs ?? INTERRUPT_SETTLEMENT_TIMEOUT_MS;
  const resubscribeBackoff = deps.resubscribeBackoffMs ?? {
    initial: RESUBSCRIBE_BACKOFF_INITIAL_MS,
    max: RESUBSCRIBE_BACKOFF_MAX_MS,
  };
  const report =
    deps.warn ??
    ((message: string) => {
      process.stderr.write(`[provider-opencode] ${message}\n`);
    });
  const warn = (message: string): void => {
    report(scrub(message));
  };
  const toolCalls = createBbToolCalls();

  function clearPendingAccept(session: ThreadSession): void {
    for (const pending of session.pendingAccepts) {
      if (pending.timer !== null) clearTimeout(pending.timer);
    }
    session.pendingAccepts = [];
  }

  function noteProviderActivity(session: ThreadSession): void {
    for (const pending of session.pendingAccepts) {
      if (pending.timer === null) continue;
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  function liveTurnIdOf(session: ThreadSession): string | undefined {
    return (
      session.liveProviderTurnId ??
      translator.executionTurnId(session.handle.id)
    );
  }

  function failureMessage(error: unknown): string {
    return error instanceof Error && error.message.length > 0
      ? error.message
      : "OpenCode event stream failed";
  }

  function flushPendingAccepts(
    session: ThreadSession,
    outbound: ThreadDelta[],
    providerTurnId: string | undefined,
  ): void {
    if (session.pendingAccepts.length === 0) return;
    const pending = session.pendingAccepts.splice(0, session.pendingAccepts.length);
    for (const item of pending) {
      if (item.timer !== null) clearTimeout(item.timer);
      outbound.push({
        kind: "input.accepted",
        clientRequestId: item.clientRequestId,
        ...(providerTurnId !== undefined ? { providerTurnId } : {}),
      });
    }
  }

  function isRootTurnMarker(delta: ThreadDelta): boolean {
    if (delta.kind !== "turn.open" && delta.kind !== "turn.boundary") return false;
    return !("parentRef" in delta) || delta.parentRef === undefined;
  }

  function sendDeltas(
    threadId: string,
    deltas: readonly ThreadDelta[],
    publishedBoundary = false,
  ): void {
    if (!publishedBoundary && deltas.some(isRootTurnMarker)) {
      throw new Error("root turn boundaries must be published through emitTurnDeltas");
    }
    const session = sessions.get(threadId);
    const outbound: ThreadDelta[] = [];
    if (session === undefined) {
      outbound.push(...deltas);
    } else {
      for (const delta of deltas) {
        outbound.push(delta);
        if (delta.kind === "turn.open" && delta.parentRef === undefined) {
          session.turnOpen = true;
          session.liveProviderTurnId = delta.providerTurnId;
          session.tools.ensurePoll();
          for (const dispatch of session.dispatches) {
            dispatch.openedTurnId ??= delta.providerTurnId;
          }
          flushPendingAccepts(session, outbound, delta.providerTurnId);
        } else if (
          delta.kind === "turn.boundary" &&
          (delta.providerTurnId === undefined ||
            delta.providerTurnId === session.liveProviderTurnId)
        ) {
          session.turnOpen = false;
          session.liveProviderTurnId = undefined;
        }
      }
    }
    if (outbound.length === 0) {
      return;
    }
    send({
      jsonrpc: "2.0",
      method: THREAD_DELTA_NOTIFICATION_METHOD,
      params: { threadId, deltas: outbound },
    });
  }

  function errorScope(
    session: ThreadSession,
  ): { providerTurnId: string } | { threadScoped: true } | Record<string, never> {
    const liveTurnId = liveTurnIdOf(session);
    if (!session.turnOpen) return { threadScoped: true };
    return liveTurnId !== undefined ? { providerTurnId: liveTurnId } : {};
  }

  function acceptDispatch(
    session: ThreadSession,
    clientRequestId: string,
    zeroWork: boolean,
    dispatch: InFlightDispatch,
    providerTurnId?: string,
  ): void {
    if (session.closed) return;
    if (!session.turnOpen && dispatch.openedTurnId !== undefined) {
      sendDeltas(session.threadId, [
        {
          kind: "input.accepted",
          clientRequestId,
          providerTurnId: dispatch.openedTurnId,
        },
      ]);
      return;
    }
    if (session.turnOpen) {
      const turnId = providerTurnId ?? liveTurnIdOf(session);
      sendDeltas(session.threadId, [
        {
          kind: "input.accepted",
          clientRequestId,
          ...(turnId !== undefined ? { providerTurnId: turnId } : {}),
        },
      ]);
      return;
    }
    const pending = {
      clientRequestId,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    session.pendingAccepts.push(pending);
    if (!zeroWork) return;
    const timer = setTimeout(() => {
      const index = session.pendingAccepts.indexOf(pending);
      if (index < 0) return;
      session.pendingAccepts.splice(index, 1);
      if (session.closed) return;
      if (session.turnOpen) {
        const turnId = liveTurnIdOf(session);
        sendDeltas(session.threadId, [
          {
            kind: "input.accepted",
            clientRequestId,
            ...(turnId !== undefined ? { providerTurnId: turnId } : {}),
          },
        ]);
        return;
      }
      zeroWorkSerial += 1;
      const settledId = `zero-work-${zeroWorkSerial}`;
      void enqueue(session, () =>
        emitTurnDeltas(session, [
          { kind: "turn.open", providerTurnId: settledId },
          { kind: "input.accepted", clientRequestId, providerTurnId: settledId },
          { kind: "turn.boundary", providerTurnId: settledId, status: "completed" },
        ]),
      ).catch((error: unknown) => {
        warn(`could not publish zero-work turn for ${session.threadId}: ${failureMessage(error)}`);
      });
    }, UNOPENED_DISPATCH_GRACE_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  async function surfaceStreamFailure(session: ThreadSession, error: unknown): Promise<void> {
    const message = failureMessage(error);
    const liveTurnId = liveTurnIdOf(session);
    const deltas: ThreadDelta[] = [];
    if (!session.turnOpen && session.pendingAccepts.length > 0) {
      zeroWorkSerial += 1;
      const providerTurnId = `zero-work-${zeroWorkSerial}`;
      const pending = session.pendingAccepts.splice(0, session.pendingAccepts.length);
      for (const item of pending) {
        if (item.timer !== null) clearTimeout(item.timer);
      }
      deltas.push({ kind: "turn.open", providerTurnId });
      for (const item of pending) {
        deltas.push({
          kind: "input.accepted",
          clientRequestId: item.clientRequestId,
          providerTurnId,
        });
      }
      deltas.push({ kind: "provider.error", message, providerTurnId });
      deltas.push({
        kind: "turn.boundary",
        providerTurnId,
        status: "failed",
        error: { message },
      });
    } else if (session.turnOpen) {
      clearPendingAccept(session);
      deltas.push({
        kind: "provider.error",
        message,
        ...(liveTurnId !== undefined ? { providerTurnId: liveTurnId } : {}),
      });
      deltas.push({
        kind: "turn.boundary",
        status: "failed",
        error: { message },
        ...(liveTurnId !== undefined ? { providerTurnId: liveTurnId } : {}),
      });
    } else {
      deltas.push({
        kind: "provider.error",
        message,
        threadScoped: true,
      });
    }
    await emitTurnDeltas(session, deltas);
    if (error instanceof OpenCodeUnauthenticatedError) {
      sendAuthRecovery(session.threadId);
    }
  }

  function sendAuthRecovery(threadId: string): void {
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.providerRecovery,
      params: {
        threadId,
        kind: "authRequired",
        message: OPENCODE_SIGN_IN_HINT,
        retryable: false,
      },
    });
  }

  function typedRequestError(error: unknown): unknown {
    if (!(error instanceof OpenCodeUnauthenticatedError)) return error;
    return new experimental_BridgeRecoveryError({
      code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      message: `${error.message}. ${OPENCODE_SIGN_IN_HINT}`,
      recovery: {
        kind: "authRequired",
        message: OPENCODE_SIGN_IN_HINT,
        retryable: false,
      },
    });
  }

  function sendIdentity(threadId: string, providerThreadId: string): void {
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
      params: { threadId, providerThreadId, sessionRestorable: true },
    });
    sendDeltas(threadId, [{ kind: "thread.identity", providerThreadId }]);
  }

  function loadOwners(): void {
    if (ownersPath === null) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(ownersPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      for (const [sessionID, record] of Object.entries(parsed)) {
        if (
          record !== null &&
          typeof record === "object" &&
          typeof (record as OwnerRecord).threadId === "string" &&
          typeof (record as OwnerRecord).cwd === "string"
        ) {
          const pending = (record as OwnerRecord).pendingDirectory;
          const capability = (record as OwnerRecord).capability;
          noteCapability(typeof capability === "string" ? capability : undefined);
          owners.set(sessionID, {
            threadId: (record as OwnerRecord).threadId,
            cwd: (record as OwnerRecord).cwd,
            ...(typeof pending === "string" && pending.length > 0 ? { pendingDirectory: pending } : {}),
            ...(typeof capability === "string" && capability.length > 0 ? { capability } : {}),
          });
        }
      }
    } catch {
      return;
    }
  }

  function enqueueOwnerWrite(): Promise<void> {
    const path = ownersPath;
    if (path === null) return Promise.resolve();
    const snapshot = JSON.stringify(Object.fromEntries(owners.entries()));
    const write = ownersWrite.then(async () => {
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    });
    ownersWrite = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  function persistOwners(): void {
    void enqueueOwnerWrite().catch((error: unknown) => {
      const path = ownersPath;
      warn(
        `could not persist OpenCode session owners to ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  function rememberOwner(sessionID: string, threadId: string, cwd: string): void {
    const previous = owners.get(sessionID);
    owners.set(sessionID, {
      threadId,
      cwd,
      ...(previous?.capability === undefined ? {} : { capability: previous.capability }),
    });
    persistOwners();
  }

  function rememberCapability(sessionID: string, capability: string): Promise<void> {
    const current = owners.get(sessionID);
    if (current === undefined) return Promise.resolve();
    noteCapability(capability);
    owners.set(sessionID, { ...current, capability });
    return enqueueOwnerWrite();
  }

  function forgetOwners(threadId: string, providerThreadId: string): void {
    let changed = false;
    for (const [sessionID, record] of owners) {
      if (record.threadId === threadId || sessionID === providerThreadId) {
        owners.delete(sessionID);
        changed = true;
      }
    }
    if (changed) persistOwners();
  }

  async function runtime(): Promise<OpenCodeRuntime> {
    if (runtimePromise === null) {
      runtimePromise = deps.createRuntime
        ? deps.createRuntime()
        : createOpenCodeRuntime();
    }
    return runtimePromise;
  }

  let cachedAppId: string | null | undefined;
  async function engineAppId(): Promise<string | null> {
    if (cachedAppId !== undefined) return cachedAppId;
    try {
      cachedAppId = (await (await runtime()).info()).appId;
    } catch {
      cachedAppId = null;
    }
    return cachedAppId;
  }

  async function refreshRuntime(): Promise<void> {
    if (runtimeRefresh === null) {
      runtimeRefresh = (async () => {
        const oc = await runtime();
        await oc.health();
      })().finally(() => {
        runtimeRefresh = null;
      });
    }
    await runtimeRefresh;
  }

  function enqueue(session: ThreadSession, work: () => Promise<void>): Promise<void> {
    session.work = session.work.then(work, work);
    return session.work;
  }

  function handleForEvent(
    session: ThreadSession,
    sessionID: string,
  ): SessionHandle | undefined {
    if (sessionID === session.handle.id) {
      return session.handle;
    }
    return session.childHandles.get(sessionID);
  }

  function isSettled(session: ThreadSession): boolean {
    return !session.busy && !session.turnOpen;
  }

  function notifySettleWaiters(session: ThreadSession): void {
    if (!isSettled(session)) return;
    for (const waiter of [...session.settleWaiters]) waiter(true);
  }

  function waitForSettlement(session: ThreadSession, timeoutMs = interruptSettlementTimeoutMs): Promise<boolean> {
    if (isSettled(session)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (settled: boolean): void => {
        clearTimeout(timer);
        session.settleWaiters.delete(finish);
        resolve(settled);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      session.settleWaiters.add(finish);
    });
  }

  function boundInterrupt(handle: SessionHandle, timeoutMs: number): Promise<void> {
    const work = handle.interrupt();
    work.catch(() => undefined);
    if (timeoutMs <= 0) {
      return Promise.reject(new Error("OpenCode interrupt timed out"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("OpenCode interrupt timed out")), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  async function interruptWithin(handle: SessionHandle, timeoutMs: number): Promise<boolean> {
    try {
      await boundInterrupt(handle, timeoutMs);
      return true;
    } catch (error) {
      warn(`could not interrupt OpenCode session ${handle.id}: ${failureMessage(error)}`);
      return false;
    }
  }

  function trackChildActivity(
    session: ThreadSession,
    sessionID: string,
    type: string,
  ): void {
    if (sessionID === session.handle.id) return;
    if (type === "session.execution.started") {
      session.busyChildren.add(sessionID);
    } else if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    ) {
      session.busyChildren.delete(sessionID);
    }
  }

  async function ensureChildHandle(
    session: ThreadSession,
    wrapped: Extract<RuntimeSessionEvent, { kind: "native" }>,
  ): Promise<ThreadDelta[]> {
    const sessionID = wrapped.sessionID;
    if (
      sessionID === session.handle.id ||
      session.childHandles.has(sessionID) ||
      session.unopenableChildren.has(sessionID)
    ) {
      return [];
    }
    try {
      const child = await (await runtime()).openSession(sessionID);
      session.childHandles.set(sessionID, child);
      return [];
    } catch (error) {
      session.unopenableChildren.add(sessionID);
      const message = failureMessage(error);
      warn(`could not open OpenCode child session ${sessionID}: ${message}`);
      return [
        {
          kind: "unhandled",
          raw: {
            jsonrpc: "2.0",
            method: "opencode/child-session-unavailable",
            params: { sessionID, parentID: wrapped.parentID ?? null, message },
          },
          rawType: "opencode/child-session-unavailable",
          vouchedTurn: false,
        },
      ];
    }
  }

  function isUnauthorizedFailure(delta: ThreadDelta): boolean {
    return (
      delta.kind === "provider.error" &&
      delta.errorInfo?.category === "unauthorized"
    );
  }

  function sendInteraction(args: {
    session: ThreadSession;
    pending: PendingInteraction;
    payload: PendingInteractionPayload;
  }): void {
    interactionSerial += 1;
    const id = `oc-int-${interactionSerial}`;
    pendingInteractions.set(id, args.pending);
    send({
      jsonrpc: "2.0",
      id,
      method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
      params: {
        providerThreadId: args.session.handle.id,
        threadId: args.session.threadId,
        turnId: null,
        payload: args.payload,
        providerNativeIds: true,
      },
    });
  }

  async function applyRuntimeEvent(
    session: ThreadSession,
    wrapped: RuntimeSessionEvent,
  ): Promise<void> {
    if (wrapped.kind === "stream.error") {
      warn(
        `OpenCode event stream for ${session.threadId} disconnected; reconnecting: ${wrapped.message}`,
      );
      sendDeltas(session.threadId, [
        {
          kind: "provider.warning",
          summary: "OpenCode event stream disconnected; reconnecting",
          details: wrapped.message,
        },
      ]);
      return;
    }
    if (wrapped.kind === "resync") {
      await session.tools.beginResync();
      const messages = await session.handle.context();
      await session.tools.reconcileUnlessOpen(session.handle.id, messages);
      return;
    }
    const native: OpenCodeNativeEvent = wrapped.event;
    if (native.type !== BB_TOOLS_CONTROL_EVENT && ignoredNativeTypes.has(native.type)) return;
    if (native.type === BB_TOOLS_CONTROL_EVENT) {
      session.tools.onControl(native.data);
      return;
    }
    session.tools.noteNative(native.type);
    if (
      wrapped.sessionID === session.handle.id &&
      PROVIDER_ACTIVITY.has(native.type)
    ) {
      noteProviderActivity(session);
    }
    trackChildActivity(session, wrapped.sessionID, native.type);
    const unavailable = await ensureChildHandle(session, wrapped);
    if (unavailable.length > 0) {
      sendDeltas(session.threadId, unavailable);
    }
    const translated = translator.translate(native, {
      threadId: session.threadId,
      ownedSessionID: session.handle.id,
      eventSessionID: wrapped.sessionID,
      parentID: wrapped.parentID,
      cwd: session.cwd,
      modelContextWindow: null,
      persistApprovals: session.persistApprovals,
    });
    if (wrapped.sessionID === session.handle.id && native.type === "session.execution.started") {
      session.tools.noteExecutionStarted(native.durable?.seq);
    }
    if (wrapped.sessionID === session.handle.id) {
      const messageID = native.data?.assistantMessageID;
      const turnId = translator.executionTurnId(session.handle.id);
      if (typeof messageID === "string" && messageID.length > 0 && turnId !== undefined) {
        session.tools.noteAssistantMessage(messageID, turnId);
      }
    }
    if (translated.gap) {
      const gapHandle = handleForEvent(session, wrapped.sessionID);
      if (gapHandle !== undefined) {
        const messages = await gapHandle.context();
        await session.tools.reconcileUnlessOpen(wrapped.sessionID, messages);
      }
    }
    await emitTurnDeltas(session, translated.deltas);
    if (translated.deltas.some(isUnauthorizedFailure)) {
      sendAuthRecovery(session.threadId);
    }
    for (const interaction of translated.interactions) {
      const handle = handleForEvent(session, interaction.sessionID);
      if (handle === undefined) {
        warn(
          `skipped an OpenCode ${interaction.kind} request from unknown session ${interaction.sessionID}`,
        );
        sendDeltas(session.threadId, [
          {
            kind: "provider.warning",
            summary: "OpenCode asked for input from a session bb cannot answer",
            details: `Session ${interaction.sessionID} is not attached to this thread; answer ${interaction.kind} ${interaction.requestID} in OpenCode.`,
          },
        ]);
        continue;
      }
      sendInteraction({
        session,
        payload: interaction.payload,
        pending:
          interaction.kind === "permission"
            ? {
                kind: "permission",
                requestID: interaction.requestID,
                persistApprovals: session.persistApprovals,
                handle,
                threadId: session.threadId,
              }
            : {
                kind: "form",
                requestID: interaction.requestID,
                form: { fields: interaction.fields, offset: 0, answer: {} },
                handle,
                threadId: session.threadId,
              },
      });
    }
    if (wrapped.sessionID === session.handle.id) {
      if (native.type === "session.execution.started") {
        session.busy = true;
      }
      if (
        native.type === "session.execution.succeeded" ||
        native.type === "session.execution.failed" ||
        native.type === "session.execution.interrupted"
      ) {
        session.busy = false;
      }
    }
    notifySettleWaiters(session);
  }

  function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  function resyncEvent(session: ThreadSession): RuntimeSessionEvent {
    return { kind: "resync", sessionID: session.handle.id, reason: "reconnect" };
  }

  async function applyGuarded(
    session: ThreadSession,
    event: RuntimeSessionEvent,
  ): Promise<void> {
    try {
      await enqueue(session, () => applyRuntimeEvent(session, event));
    } catch (error) {
      if (session.closed || session.abort.signal.aborted) return;
      const message = failureMessage(error);
      warn(
        `could not apply OpenCode ${event.kind === "native" ? event.event.type : event.kind} for ${session.threadId}: ${message}`,
      );
      sendDeltas(session.threadId, [
        { kind: "provider.error", message, ...errorScope(session) },
      ]);
      if (event.kind !== "native") return;
      try {
        await enqueue(session, () => applyRuntimeEvent(session, resyncEvent(session)));
      } catch (resyncError) {
        warn(
          `could not resync OpenCode session ${session.handle.id}: ${failureMessage(resyncError)}`,
        );
      }
    }
  }

  function startPump(session: ThreadSession, ocRuntime: OpenCodeRuntime): void {
    const run = async () => {
      let backoffMs = resubscribeBackoff.initial;
      let resubscribed = false;
      while (!session.closed && !session.abort.signal.aborted) {
        try {
          const events = ocRuntime.subscribe(session.handle.id, session.abort.signal);
          if (resubscribed) {
            await applyGuarded(session, resyncEvent(session));
          }
          for await (const event of events) {
            if (session.closed) return;
            backoffMs = resubscribeBackoff.initial;
            await applyGuarded(session, event);
            if (session.closed) return;
          }
        } catch (error) {
          if (session.closed || session.abort.signal.aborted) return;
          await surfaceStreamFailure(session, error);
          void detachSession(session);
          return;
        }
        if (session.closed || session.abort.signal.aborted) return;
        warn(
          `OpenCode event stream for ${session.threadId} ended; resubscribing in ${backoffMs}ms`,
        );
        await sleepUnlessAborted(backoffMs, session.abort.signal);
        backoffMs = Math.min(backoffMs * 2, resubscribeBackoff.max);
        resubscribed = true;
      }
    };
    void run();
  }

  function sessionPermissions(
    knobs: AppliedSessionKnobs,
    disallowedTools: readonly string[],
  ): OpenCodePermissionRule[] {
    return [...knobs.permissions, ...disallowedToolRules(disallowedTools)];
  }

  async function applyKnobs(
    session: ThreadSession,
    knobs: AppliedSessionKnobs,
    instructions: "construct" | "frozen",
  ): Promise<void> {
    session.persistApprovals = knobs.persistApprovals;
    session.bbToolsRequired = knobs.bbToolsRequired;
    if (instructions === "construct") {
      await session.handle.setInstructions({
        mode: "append",
        text: knobs.instructions?.text ?? "",
      });
    }
    await session.handle.setEnvironment(knobs.env);
    await session.handle.update({
      permissions: sessionPermissions(knobs, session.disallowedTools),
    });
    if (knobs.model !== undefined) {
      await session.handle.switchModel(knobs.model);
    }
    if (knobs.agent !== null) {
      await session.handle.switchAgent(knobs.agent);
    }
  }

  async function emitTurnDeltas(session: ThreadSession, deltas: readonly ThreadDelta[]): Promise<void> {
    const outgoing = await session.tools.consumeBoundary(deltas);
    if (outgoing.length === 0) return;
    sendDeltas(session.threadId, outgoing, true);
  }

  const ACTIVITY_RETRY_MS = 250;

  function scheduleActivityRetry(session: ThreadSession, sessionID: string): void {
    if (session.activityRetryUsed || session.closed) return;
    session.activityRetryUsed = true;
    const timer = setTimeout(() => {
      session.activityRetryTimer = undefined;
      void enqueue(session, async () => {
        if (session.closed) return;
        const handle =
          sessionID === session.handle.id ? session.handle : session.childHandles.get(sessionID);
        const messages = await handle?.context().catch(() => []);
        await session.tools.reconcileUnlessOpen(sessionID, messages ?? []);
      });
    }, ACTIVITY_RETRY_MS);
    timer.unref?.();
    session.activityRetryTimer = timer;
  }

  async function noteTerminals(session: ThreadSession, sessionID: string): Promise<void> {
    const handle =
      sessionID === session.handle.id ? session.handle : session.childHandles.get(sessionID);
    if (handle === undefined) {
      translator.noteNativeTerminals(sessionID, nativeTerminalsFromEvents([], false));
      translator.noteSessionLiveness(sessionID, undefined);
      return;
    }
    try {
      const read = await handle.durableLog();
      translator.noteNativeTerminals(
        sessionID,
        nativeTerminalsFromEvents(read.events, read.complete),
      );
    } catch (error) {
      warn(
        `could not read OpenCode session log for ${session.threadId}: ${failureMessage(error)}`,
      );
      translator.noteNativeTerminals(sessionID, nativeTerminalsFromEvents([], false));
    }
    try {
      const live = await handle.activity();
      translator.noteSessionLiveness(sessionID, live);
      session.activityRetryUsed = false;
    } catch (error) {
      warn(
        `could not read OpenCode session activity for ${session.threadId}: ${failureMessage(error)}`,
      );
      translator.noteSessionLiveness(sessionID, undefined);
      scheduleActivityRetry(session, sessionID);
    }
  }

  function toolHost(session: ThreadSession): BbToolHost {
    return {
      get threadId() {
        return session.threadId;
      },
      get closed() {
        return session.closed;
      },
      get turnOpen() {
        return session.turnOpen;
      },
      get busy() {
        return session.busy;
      },
      get handle() {
        return session.handle;
      },
      get disallowedTools() {
        return session.disallowedTools;
      },
      get bbToolsRequired() {
        return session.bbToolsRequired;
      },
      appId: () => engineAppId(),
      takeoverCapability: () => {
        const capability = owners.get(session.handle.id)?.capability;
        noteCapability(capability);
        return capability;
      },
      rememberCapability: (capability) => rememberCapability(session.handle.id, capability),
      secrets: () => {
        noteCapability(session.tools?.capability());
        noteCapability(owners.get(session.handle.id)?.capability);
        return [...knownCapabilities];
      },
      listPlugins: async () => (await runtime()).listPlugins(session.handle.location),
      get hasDeferredResync() {
        return session.deferredResyncMessages !== undefined;
      },
      liveTurnId: () => liveTurnIdOf(session),
      executionTurnId: () => translator.executionTurnId(session.handle.id),
      warn,
      send,
      enqueue: (work) => enqueue(session, work),
      durableLog: () => session.handle.durableLog(),
      emitTurnDeltas: (deltas) => emitTurnDeltas(session, deltas),
      settleTurn: (outcome) => translator.settleTurn(session.handle.id, outcome),
      reconcileAfterResync: (sessionID, messages) => translator.reconcileAfterResync(sessionID, messages),
      noteBbCatalog(bindingID) {
        const tools = session.bbTools;
        if (tools === undefined) return;
        translator.configureInjectedTools(session.handle.id, tools, bindingID);
      },
      prepareReconcile: (sessionID) => noteTerminals(session, sessionID),
      takeDeferredResync() {
        const messages = session.deferredResyncMessages;
        session.deferredResyncMessages = undefined;
        return messages;
      },
      setDeferredResync(messages) {
        session.deferredResyncMessages = messages;
      },
    };
  }

  async function confirmIdleBeforeMove(session: ThreadSession): Promise<boolean> {
    if (isSettled(session)) return true;
    const deadline = Date.now() + interruptSettlementTimeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const interrupted = await interruptWithin(session.handle, remaining());
    if (!interrupted) return false;
    const settled = await waitForSettlement(session, remaining());
    if (!settled) return false;
    await session.tools.abandon();
    return true;
  }

  async function retireSession(
    threadId: string,
    nextHandleId: string,
  ): Promise<ThreadSession | undefined> {
    const existing = sessions.get(threadId);
    if (existing === undefined) return undefined;
    if (existing.handle.id !== nextHandleId && !isSettled(existing)) {
      await interruptWithin(existing.handle, interruptSettlementTimeoutMs);
    }
    await enqueue(existing, async () => {
      await emitTurnDeltas(existing, translator.settleTurn(existing.handle.id, "interrupted"));
    }).catch(() => undefined);
    await detachSession(existing);
    return existing;
  }

  function sendReplaced(
    previous: ThreadSession,
    next: SessionHandle,
    method: "thread/start" | "thread/resume" | "thread/fork",
  ): void {
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
      params: {
        threadId: previous.threadId,
        providerThreadId: next.id,
        reason: `OpenCode session ${previous.handle.id} was replaced by ${next.id} for ${method}.`,
        contextLost: method === "thread/start" && previous.handle.id !== next.id,
      },
    });
  }

  function registerSession(
    threadId: string,
    handle: SessionHandle,
    cwd: string,
    disallowedTools: readonly string[],
    remember = true,
  ): ThreadSession {
    const session: ThreadSession = {
      threadId,
      handle,
      cwd,
      abort: new AbortController(),
      closed: false,
      persistApprovals: false,
      busy: false,
      work: Promise.resolve(),
      childHandles: new Map(),
      catalog: [],
      disallowedTools,
      bbToolsRequired: false,
      busyChildren: new Set(),
      unopenableChildren: new Set(),
      settleWaiters: new Set(),
      turnOpen: false,
      liveProviderTurnId: undefined,
      deferredResyncMessages: undefined,
      pendingAccepts: [],
      dispatches: new Set(),
      tools: undefined as unknown as BbToolSession,
      bbTools: undefined,
      activityRetryUsed: false,
      activityRetryTimer: undefined,
    };
    session.tools = toolCalls.bind(toolHost(session));
    sessions.set(threadId, session);
    sessionsByProviderId.set(handle.id, session);
    if (remember) rememberOwner(handle.id, threadId, cwd);
    return session;
  }

  async function detachSession(session: ThreadSession): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    if (session.activityRetryTimer !== undefined) {
      clearTimeout(session.activityRetryTimer);
      session.activityRetryTimer = undefined;
    }
    clearPendingAccept(session);
    prunePendingInteractions(session.threadId);
    await session.tools.abandon();
    session.tools.close();
    session.abort.abort();
    if (sessions.get(session.threadId) === session) {
      sessions.delete(session.threadId);
    }
    if (sessionsByProviderId.get(session.handle.id) === session) {
      sessionsByProviderId.delete(session.handle.id);
    }
    for (const waiter of [...session.settleWaiters]) waiter(false);
    await session.work.catch(() => undefined);
    const busyChildren = [...session.busyChildren].flatMap((childId) => {
      const handle = session.childHandles.get(childId);
      return handle === undefined ? [] : [handle];
    });
    session.busyChildren.clear();
    await Promise.all(
      busyChildren.map((child) => interruptWithin(child, interruptSettlementTimeoutMs)),
    );
    translator.forget(session.handle.id);
    for (const childId of session.childHandles.keys()) {
      translator.forget(childId);
    }
  }

  function announce(id: string | number, threadId: string, providerThreadId: string): void {
    translator.reset(providerThreadId);
    sendIdentity(threadId, providerThreadId);
    sendDeltas(threadId, [{ kind: "session.reset" }]);
    sendResult(id, { providerThreadId, sessionRestorable: true });
  }

  function nativeDirectory(info: { location: { directory: string } }): string {
    return info.location.directory;
  }

  async function assertOwned(
    handle: SessionHandle,
    threadId: string,
    cwd: string,
  ): Promise<"ok" | "migrate"> {
    const info = await handle.info();
    const native = nativeDirectory(info);
    const mapped = owners.get(handle.id);
    const metadataId = bbThreadIdFromMetadata(info.metadata);
    if (mapped !== undefined) {
      if (mapped.threadId !== threadId) {
        throw new Error(
          `OpenCode session ${handle.id} belongs to thread ${mapped.threadId}, not ${threadId}`,
        );
      }
      if (mapped.pendingDirectory !== undefined) {
        if (cwd !== mapped.pendingDirectory) {
          throw new Error(
            `OpenCode session ${handle.id} is moving to ${mapped.pendingDirectory}, not ${cwd}`,
          );
        }
        if (native.length > 0 && native !== cwd) return "migrate";
        return "ok";
      }
      if (mapped.cwd !== cwd) return "migrate";
      if (native.length > 0 && native !== cwd) {
        throw new Error(
          `OpenCode session ${handle.id} is bound to ${native}, not ${cwd}`,
        );
      }
      return "ok";
    }
    if (metadataId === undefined) {
      throw new Error(
        `OpenCode session ${handle.id} has no bbThreadId and is not a bb-owned session`,
      );
    }
    if (metadataId !== threadId) {
      throw new Error(
        `OpenCode session ${handle.id} belongs to thread ${metadataId}, not ${threadId}`,
      );
    }
    if (native.length > 0 && native !== cwd) {
      throw new Error(
        `OpenCode session ${handle.id} is bound to ${native}, not ${cwd}`,
      );
    }
    return "ok";
  }

  async function assertForkSource(handle: SessionHandle, cwd: string): Promise<void> {
    const mapped = owners.get(handle.id);
    if (mapped !== undefined) {
      if (mapped.cwd !== cwd) {
        throw new Error(
          `OpenCode session ${handle.id} is bound to ${mapped.cwd}, not ${cwd}`,
        );
      }
      return;
    }
    const info = await handle.info();
    if (bbThreadIdFromMetadata(info.metadata) === undefined) {
      throw new Error(
        `OpenCode session ${handle.id} has no bbThreadId and is not a bb-owned session`,
      );
    }
    if (info.location.directory !== cwd) {
      throw new Error(
        `OpenCode session ${handle.id} is bound to ${info.location.directory}, not ${cwd}`,
      );
    }
  }

  async function catalogFor(cwd: string): Promise<OpenCodeModel[]> {
    const oc = await runtime();
    return oc.models({ directory: cwd });
  }

  async function assertRequestedAgent(cwd: string, agent: string | null): Promise<void> {
    if (agent === null) {
      return;
    }
    const listed = await (await runtime()).agents({ directory: cwd });
    assertSelectableAgentId(agent, listed.agents);
  }

  async function assertRequestedSkills(
    cwd: string,
    skills: readonly { id: string }[],
  ): Promise<void> {
    if (skills.length === 0) return;
    const listed = await (await runtime()).skills({ directory: cwd });
    const known = new Set(listed.map((skill) => skill.id));
    for (const skill of skills) {
      if (!known.has(skill.id)) {
        throw new Error(`Unknown OpenCode skill "${skill.id}"`);
      }
    }
  }

  function prunePendingInteractions(threadId: string): void {
    for (const [id, pending] of pendingInteractions) {
      if (pending.threadId === threadId) pendingInteractions.delete(id);
    }
  }

  async function constructSession(args: {
    id: string | number;
    method: "thread/start" | "thread/resume" | "thread/fork";
    threadId: string;
    cwd: string;
    handle: SessionHandle;
    catalog: OpenCodeModel[];
    knobs: AppliedSessionKnobs;
    disallowedTools: readonly string[];
    instructions: "construct" | "frozen";
    dynamicTools: readonly DynamicTool[] | undefined;
    previous?: ThreadSession;
    skipRetire?: boolean;
    durableOwner?: boolean;
    toolAttachMode?: "construct" | "turn";
  }): Promise<void> {
    const previous = args.skipRetire
      ? args.previous
      : await retireSession(args.threadId, args.handle.id);
    const oc = await runtime();
    const session = registerSession(
      args.threadId,
      args.handle,
      args.cwd,
      args.disallowedTools,
      args.durableOwner !== true,
    );
    session.catalog = args.catalog;
    if (previous !== undefined) {
      sendReplaced(previous, args.handle, args.method);
    }
    startPump(session, oc);
    try {
      await applyKnobs(session, args.knobs, args.instructions);
      if (args.method === "thread/fork") {
        const info = await args.handle.info();
        await args.handle.update({
          metadata: { ...(info.metadata ?? {}), bbThreadId: args.threadId },
        });
      }
      session.bbTools = args.dynamicTools;
      if (args.dynamicTools !== undefined) {
        translator.configureInjectedTools(session.handle.id, args.dynamicTools);
      }
      await session.tools.attach(args.dynamicTools, args.toolAttachMode ?? "construct");
      if (args.durableOwner === true) {
        const mapped = owners.get(args.handle.id);
        owners.set(args.handle.id, {
          threadId: args.threadId,
          cwd: args.cwd,
          ...(mapped?.capability === undefined ? {} : { capability: mapped.capability }),
        });
        try {
          await enqueueOwnerWrite();
        } catch (error) {
          if (mapped !== undefined) owners.set(args.handle.id, mapped);
          await detachSession(session);
          throw new Error(
            `OpenCode session ${args.handle.id} moved to ${args.cwd} but the new owner could not be saved: ${failureMessage(error)}. Resume this thread in ${args.cwd} to finish the move.`,
          );
        }
      }
      announce(args.id, args.threadId, args.handle.id);
    } catch (error) {
      if (sessions.get(args.threadId) === session && !session.closed) {
        await detachSession(session);
      }
      throw error;
    }
  }

  function hasInterruptibleWork(
    session: ThreadSession,
    activeTurnId: string | null,
  ): boolean {
    if (session.busy || session.turnOpen) return true;
    return (
      activeTurnId !== null &&
      (session.pendingAccepts.length > 0 || session.dispatches.size > 0)
    );
  }

  async function handleRequest(
    request: OpenCodeCommand & { id: string | number },
  ): Promise<void> {
    switch (request.method) {
      case "model/list":
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
      case "thread/name/set":
      case "turn/start":
      case "turn/steer":
        await refreshRuntime();
        break;
      case "provider/health":
        if (runtimePromise !== null) await refreshRuntime();
        break;
    }
    switch (request.method) {
      case "initialize": {
        const result: InitializeResult = {
          protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
          capabilities: {
            sessionRestore: true,
            threadArchive: false,
            threadRename: true,
            threadGoalClear: false,
            fork: "checkpoint",
            approvalEnforcedBy: "runtime",
            grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
            steerMode: "inject",
            skills: { configure: false },
          },
        };
        sendResult(request.id, result);
        break;
      }
      case "model/list": {
        const oc = await runtime();
        const directory = request.params.cwd ?? homedir();
        const models = await oc.models({ directory });
        const defaultModel = models.find((model) => model.isDefault);
        sendResult(request.id, {
          models: toAvailableModels({
            models,
            defaultModel:
              defaultModel === undefined
                ? null
                : {
                    providerID: defaultModel.providerID,
                    id: defaultModel.id,
                    ...(defaultModel.defaultVariant !== undefined
                      ? { variant: defaultModel.defaultVariant }
                      : {}),
                  },
          }),
          selectedOnlyModels: [],
        });
        break;
      }
      case "provider/health": {
        sendResult(request.id, await getOpenCodeProviderHealth());
        break;
      }
      case "provider/usage": {
        sendResult(request.id, { supported: false });
        break;
      }
      case "provider/installation/status": {
        sendResult(
          request.id,
          await getOpenCodeProviderInstallationStatus({
            ...(request.params.requirement !== undefined
              ? { requirement: request.params.requirement }
              : {}),
          }),
        );
        break;
      }
      case "provider/installation/run": {
        if (request.params.action === "update") {
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            "OpenCode updates are not managed by bb; update OpenCode with its own upgrade command.",
          );
          break;
        }
        sendResult(
          request.id,
          await getOpenCodeProviderInstallationRun(request.params.action),
        );
        break;
      }
      case "thread/start": {
        if (request.params.input !== undefined && request.params.input.length > 0) {
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            "OpenCode thread/start does not take input; send it with turn/start.",
          );
          break;
        }
        const catalog = await catalogFor(request.params.cwd);
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: request.params.instructionMode,
          catalog,
        });
        const disallowedTools = request.params.disallowedTools ?? [];
        const oc = await runtime();
        await assertRequestedAgent(request.params.cwd, knobs.agent);
        const handle = await oc.createSession({
          location: { directory: request.params.cwd },
          title: sessionTitleForThread(request.params.threadId),
          ...(knobs.agent !== null ? { agent: knobs.agent } : {}),
          ...(knobs.model !== undefined ? { model: knobs.model } : {}),
          metadata: { bbThreadId: request.params.threadId },
          permissionMode: knobs.permissionMode,
          permissions: sessionPermissions(knobs, disallowedTools),
          ...(knobs.instructions !== null ? { instructions: knobs.instructions } : {}),
          environment: knobs.env,
        });
        await constructSession({
          id: request.id,
          method: request.method,
          threadId: request.params.threadId,
          cwd: request.params.cwd,
          handle,
          catalog,
          knobs,
          disallowedTools,
          instructions: "frozen",
          dynamicTools: request.params.dynamicTools,
        });
        break;
      }
      case "thread/resume": {
        const catalog = await catalogFor(request.params.cwd);
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: request.params.instructionMode,
          catalog,
        });
        const oc = await runtime();
        await assertRequestedAgent(request.params.cwd, knobs.agent);
        let handle: SessionHandle;
        try {
          handle = await oc.openSession(request.params.providerThreadId);
        } catch (error) {
          if (error instanceof OpenCodeUnauthenticatedError) throw error;
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
        let ownership: "ok" | "migrate";
        try {
          ownership = await assertOwned(handle, request.params.threadId, request.params.cwd);
        } catch (error) {
          if (error instanceof OpenCodeUnauthenticatedError) throw error;
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
        const completingMigration =
          ownership === "migrate" || owners.get(handle.id)?.pendingDirectory === request.params.cwd;
        const live = sessions.get(request.params.threadId);
        if (
          completingMigration &&
          live !== undefined &&
          live.handle.id === handle.id &&
          !isSettled(live)
        ) {
          const settled = await confirmIdleBeforeMove(live);
          if (!settled) {
            sendError(
              request.id,
              BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
              `OpenCode session ${handle.id} still has an active turn and could not be interrupted before moving to ${request.params.cwd}. Resume this thread in ${request.params.cwd} to finish the move.`,
            );
            break;
          }
        }
        let previous: ThreadSession | undefined;
        if (completingMigration) {
          previous = await retireSession(request.params.threadId, handle.id);
        }
        if (ownership === "migrate") {
          const before = await handle.info();
          try {
            if (before.location.directory !== request.params.cwd) {
              handle = await handle.move(request.params.cwd);
            }
          } catch (error) {
            if (error instanceof OpenCodeUnauthenticatedError) throw error;
            sendError(
              request.id,
              BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
              `OpenCode session ${handle.id} could not be moved to ${request.params.cwd}: ${failureMessage(error)}. Resume this thread in ${request.params.cwd} to finish the move.`,
            );
            break;
          }
          const mapped = owners.get(handle.id);
          owners.set(handle.id, {
            threadId: request.params.threadId,
            cwd: mapped?.cwd ?? before.location.directory,
            pendingDirectory: request.params.cwd,
            ...(mapped?.capability === undefined ? {} : { capability: mapped.capability }),
          });
          try {
            await enqueueOwnerWrite();
          } catch (error) {
            sendError(
              request.id,
              BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
              `OpenCode session ${handle.id} moved to ${request.params.cwd} but the new owner could not be saved: ${failureMessage(error)}. Resume this thread in ${request.params.cwd} to finish the move.`,
            );
            break;
          }
        }
        const construction = {
          id: request.id,
          method: request.method,
          threadId: request.params.threadId,
          cwd: request.params.cwd,
          handle,
          catalog,
          knobs,
          disallowedTools: request.params.disallowedTools ?? [],
          instructions: "construct" as const,
          dynamicTools: request.params.dynamicTools,
          previous,
          skipRetire: completingMigration,
          durableOwner: completingMigration,
          toolAttachMode: completingMigration ? ("turn" as const) : ("construct" as const),
        };
        if (!completingMigration) {
          await constructSession(construction);
          break;
        }
        try {
          await constructSession(construction);
        } catch (error) {
          if (error instanceof OpenCodeUnauthenticatedError) throw error;
          const live = sessions.get(request.params.threadId);
          if (live !== undefined && !live.closed) await detachSession(live);
          const message = failureMessage(error);
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
            message.includes("Resume this thread")
              ? message
              : `OpenCode session ${handle.id} moved to ${request.params.cwd} but could not be restored: ${message}. Resume this thread in ${request.params.cwd} to finish the move.`,
          );
        }
        break;
      }
      case "thread/fork": {
        const catalog = await catalogFor(request.params.cwd);
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: request.params.instructionMode,
          catalog,
        });
        const oc = await runtime();
        await assertRequestedAgent(request.params.cwd, knobs.agent);
        const source =
          sessionsByProviderId.get(request.params.sourceProviderThreadId)?.handle ??
          (await oc.openSession(request.params.sourceProviderThreadId));
        await assertForkSource(source, request.params.cwd);
        const handle = await source.fork(request.params.sourceProviderCheckpointId);
        await constructSession({
          id: request.id,
          method: request.method,
          threadId: request.params.threadId,
          cwd: request.params.cwd,
          handle,
          catalog,
          knobs,
          disallowedTools: request.params.disallowedTools ?? [],
          instructions: "construct",
          dynamicTools: request.params.dynamicTools,
        });
        break;
      }
      case "turn/start":
      case "turn/steer": {
        const session = sessions.get(request.params.threadId);
        if (session === undefined || session.closed) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "No active OpenCode session");
          break;
        }
        if (session.handle.id !== request.params.providerThreadId) {
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
            "providerThreadId does not match the live session",
          );
          break;
        }
        const incomingDisallowed = stringListParam(request.params, "disallowedTools");
        if (incomingDisallowed !== undefined) session.disallowedTools = incomingDisallowed;
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: "append",
          catalog: session.catalog,
        });
        session.bbToolsRequired = knobs.bbToolsRequired;
        try {
          await session.tools.ensure();
        } catch (error) {
          if (error instanceof BbToolsSetupError) {
            sendError(request.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, error.message);
            break;
          }
          throw error;
        }
        if (request.method === "turn/steer") {
          const liveTurn = liveTurnIdOf(session);
          if (
            !(session.busy || session.turnOpen) ||
            liveTurn !== request.params.expectedTurnId
          ) {
            throw new experimental_BridgeRecoveryError({
              code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
              message: "No active turn to steer",
              recovery: {
                kind: "staleTurn",
                message: "No active turn to steer",
                retryable: false,
              },
            });
          }
        }
        await assertRequestedAgent(session.cwd, knobs.agent);
        await applyKnobs(session, knobs, "frozen");
        await session.tools.pushDisallowed();
        const delivery =
          request.method === "turn/steer" ? "steer" : session.busy ? "queue" : "steer";
        const turn = classifyOpenCodeTurn({
          input: request.params.input,
          delivery,
        });
        if (turn.kind === "prompt") {
          await assertRequestedSkills(session.cwd, turn.prompt.skills ?? []);
        } else if (turn.kind === "command") {
          await assertRequestedSkills(session.cwd, turn.command.skills ?? []);
        }
        const dispatch: InFlightDispatch = { openedTurnId: undefined };
        session.dispatches.add(dispatch);
        try {
          if (turn.kind === "compact") {
            await session.handle.compact();
          } else if (turn.kind === "command") {
            await session.handle.command(turn.command);
          } else {
            await session.handle.prompt(turn.prompt);
          }
        } catch (error) {
          if (error instanceof OpenCodeUnauthenticatedError) throw error;
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
            error instanceof Error ? error.message : "OpenCode turn dispatch failed",
          );
          break;
        } finally {
          session.dispatches.delete(dispatch);
        }
        acceptDispatch(
          session,
          request.params.clientRequestId,
          turn.kind === "compact",
          dispatch,
          request.method === "turn/steer" ? request.params.expectedTurnId : undefined,
        );
        sendResult(request.id, { threadId: request.params.threadId });
        break;
      }
      case "thread/stop": {
        const session = sessions.get(request.params.threadId);
        if (session === undefined) {
          sendResult(request.id, { ok: true, providerCheckpointId: null });
          break;
        }
        await session.tools.abandon();
        if (request.params.intent === "release") {
          await enqueue(session, async () => {
            await emitTurnDeltas(session, translator.settleUnobserved(session.handle.id));
          });
        }
        if (request.params.intent === "interrupt" && hasInterruptibleWork(session, request.params.activeTurnId)) {
          const deadline = Date.now() + interruptSettlementTimeoutMs;
          const remaining = (): number => Math.max(0, deadline - Date.now());
          await interruptWithin(session.handle, remaining());
          const settled = await waitForSettlement(session, remaining());
          if (!settled && !session.closed) {
            await enqueue(session, async () => {
              await emitTurnDeltas(
                session,
                translator.settleTurn(session.handle.id, "interrupted"),
              );
            });
          }
        }
        const checkpointId = translator.checkpoint(session.handle.id) ?? null;
        await detachSession(session);
        sendResult(request.id, { ok: true, providerCheckpointId: checkpointId });
        break;
      }
      case "thread/discard": {
        const session = sessions.get(request.params.threadId);
        if (session !== undefined) {
          await detachSession(session);
        }
        forgetOwners(request.params.threadId, request.params.providerThreadId);
        sendResult(request.id, { ok: true });
        break;
      }
      case "thread/name/set": {
        const session = sessions.get(request.params.threadId);
        if (session === undefined || session.closed) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "No active OpenCode session");
          break;
        }
        await session.handle.update({ title: request.params.title });
        sendDeltas(request.params.threadId, [
          { kind: "thread.name", name: request.params.title },
        ]);
        sendResult(request.id, { ok: true });
        break;
      }
    }
  }

  function rejectInteraction(
    id: string | number,
    message: string,
  ): void {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message);
  }

  function deliverInteraction(
    pending: PendingInteraction,
    id: string,
    sendReply: () => Promise<void>,
  ): void {
    replyingInteractions.add(id);
    void refreshRuntime()
      .then(sendReply)
      .then(() => {
        replyingInteractions.delete(id);
        if (pendingInteractions.get(id) === pending) {
          pendingInteractions.delete(id);
        }
      })
      .catch((error: unknown) => {
        replyingInteractions.delete(id);
        const session = sessions.get(pending.threadId);
        sendDeltas(pending.threadId, [
          {
            kind: "provider.error",
            message:
              error instanceof Error
                ? error.message
                : "OpenCode interaction reply failed",
            ...(session === undefined ? { threadScoped: true } : errorScope(session)),
          },
        ]);
      });
  }

  function handleInteractionResponse(response: {
    id: string | number;
    result?: unknown;
    error?: { code: number; message?: string };
  }): void {
    const id = String(response.id);
    const pending = pendingInteractions.get(id);
    if (pending === undefined || replyingInteractions.has(id)) return;
    if ("error" in response && response.error !== undefined) {
      deliverInteraction(pending, id, async () => {
        if (pending.kind === "permission") {
          await pending.handle.replyPermission(pending.requestID, "reject");
          return;
        }
        await pending.handle.cancelForm(pending.requestID);
      });
      return;
    }
    const resolution = pendingInteractionResolutionSchema.safeParse(response.result);
    if (!resolution.success) {
      rejectInteraction(response.id, "Invalid OpenCode interaction resolution");
      return;
    }
    if (pending.kind === "permission") {
      if (!isApprovalPendingInteractionResolution(resolution.data)) {
        rejectInteraction(
          response.id,
          "OpenCode permission interaction expected an approval decision",
        );
        return;
      }
      const reply = mapApprovalToOpenCodeReply({
        decision: resolution.data.decision,
        persistApprovals: pending.persistApprovals,
      });
      deliverInteraction(pending, id, () =>
        pending.handle.replyPermission(pending.requestID, reply),
      );
      return;
    }
    if (!isUserQuestionPendingInteractionResolution(resolution.data)) {
      rejectInteraction(
        response.id,
        "OpenCode form interaction expected a form answer",
      );
      return;
    }
    const form = pending.form;
    let pageAnswer: Record<string, OpenCodeFormValue>;
    try {
      pageAnswer = openCodeFormPageAnswer(
        openCodeFormPage(form.fields, form.offset),
        resolution.data.answers,
      );
    } catch (error) {
      rejectInteraction(
        response.id,
        error instanceof Error
          ? error.message
          : "OpenCode form answer does not match the requested fields",
      );
      return;
    }
    const answer = { ...form.answer, ...pageAnswer };
    const nextOffset = form.offset + openCodeFormPage(form.fields, form.offset).length;
    const session = sessions.get(pending.threadId);
    if (nextOffset < form.fields.length && session !== undefined) {
      pendingInteractions.delete(id);
      const nextForm = { fields: form.fields, offset: nextOffset, answer };
      sendInteraction({
        session,
        payload: openCodeFormQuestionPayload(openCodeFormPage(form.fields, nextOffset)),
        pending: { ...pending, form: nextForm },
      });
      return;
    }
    deliverInteraction(pending, id, () =>
      pending.handle.replyForm(pending.requestID, answer),
    );
  }

  function handleParsedMessage(parsed: unknown): void {
    const response = decodeBridgeJsonRpcResponse(parsed);
    if (response !== null) {
      if (toolCalls.handleResponse(response)) return;
      if (pendingInteractions.has(String(response.id))) {
        handleInteractionResponse(response);
      }
      return;
    }
    const decoded = decodeRequest(parsed);
    if (decoded.kind === "ignored") {
      return;
    }
    if (decoded.kind === "unknown-method") {
      sendError(
        decoded.id,
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method "${decoded.method}"`,
      );
      return;
    }
    if (decoded.kind === "invalid-params") {
      sendError(
        decoded.id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid params for "${decoded.method}": ${decoded.issues}`,
      );
      return;
    }
    runBridgeRequest({
      request: decoded.request,
      handleRequest: (request) =>
        handleRequest(request).catch((error: unknown) => {
          throw typedRequestError(error);
        }),
      sendError,
    });
  }

  const handleLine = createBridgeLineHandler({ handleParsedMessage });

  async function closeAll(): Promise<void> {
    closed = true;
    const live = [...sessions.values()];
    await Promise.all(live.map((session) => detachSession(session)));
    pendingInteractions.clear();
    replyingInteractions.clear();
    await ownersWrite;
    if (runtimePromise !== null) {
      const oc = await runtimePromise.catch(() => null);
      await oc?.close();
      runtimePromise = null;
    }
  }

  const experimental_providerBridge = experimental_defineProviderBridge({
    handleLine,
    start(context: ProviderBridgeContext) {
      closed = false;
      ownersPath = join(context.dataDir, "opencode-session-owners.json");
      try {
        mkdirSync(context.dataDir, { recursive: true });
      } catch (error) {
        warn(
          `could not create OpenCode data dir ${context.dataDir}: ${failureMessage(error)}`,
        );
      }
      loadOwners();
    },
    onClose() {
      void closeAll();
    },
  });

  function setIgnoreBbToolControl(enabled: boolean): void {
    toolCalls.setIgnoreControl(enabled);
  }

  function setIgnoredNativeEvents(types: readonly string[]): void {
    ignoredNativeTypes = new Set(types);
  }

  function forgetOriginMap(threadId: string): void {
    sessions.get(threadId)?.tools.forgetOrigins();
  }

  function injectTurnDeltas(threadId: string, deltas: ThreadDelta[]): Promise<void> {
    const session = sessions.get(threadId);
    if (session === undefined || session.closed) return Promise.resolve();
    return enqueue(session, () => emitTurnDeltas(session, deltas));
  }

  async function injectResync(threadId: string): Promise<void> {
    const session = sessions.get(threadId);
    if (session === undefined || session.closed) return;
    await applyGuarded(session, resyncEvent(session));
  }

  function bbToolCapability(threadId: string): string | undefined {
    return sessions.get(threadId)?.tools.capability();
  }

  return {
    handleLine,
    experimental_providerBridge,
    closeAll,
    injectResync,
    bbToolCapability,
    setIgnoreBbToolControl,
    setIgnoredNativeEvents,
    forgetOriginMap,
    injectTurnDeltas,
    get closed() {
      return closed;
    },
  };
}

const defaultBridge = createOpenCodeBridge();

export const handleLine = defaultBridge.handleLine;
export const experimental_providerBridge = defaultBridge.experimental_providerBridge;

export async function experimental_closeAllForTests(): Promise<void> {
  await defaultBridge.closeAll();
}
