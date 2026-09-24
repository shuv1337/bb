import type { DynamicTool, ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { bbToolsRequiredSetupMessage } from "../bb-tools-required.js";
import {
  companionPluginSpecsFrom,
  duplicateCompanionAttachmentMessage,
} from "../companion-status-contract.js";
import type { DurableLogRead, OpenCodeNativeEvent, OpenCodeSessionMessage, SessionHandle } from "../runtime/index.js";
import { OpenCodeUnauthenticatedError } from "../runtime/index.js";
import {
  ABSENT_COMPANION_WARNING_SUMMARY,
  absentCompanionWarningDetails,
} from "../strings.js";
import {
  BB_TOOL_TEARDOWN_RPC_MS,
  BB_TOOLS_RPC,
  BbToolsRpcError,
  BbToolsSetupError,
  bbToolCallResultSchema,
  classifyBbToolsRpcError,
  createBbToolsClient,
  DEFAULT_BB_TOOLS_LIMITS,
  failureMessage,
  isCompanionAbsent,
  isUnboundRpc,
  redactCompanionSecrets,
  withTimeout,
  type BbPendingToolCall,
  type BbToolCallResult,
  type BbToolPendingOutput,
  type BbToolsClient,
  type BbToolsHello,
  type BbToolsLimits,
  type BbToolsRpc,
} from "../runtime/tool-bridge.js";

export { BbToolsSetupError, BB_TOOLS_RPC };

export const BB_TOOL_CALL_CANCELLED = "bb tool call cancelled";
export const BB_TOOL_OUTCOME_UNKNOWN =
  "bb tool outcome unknown: claimed call was cancelled before a result arrived";

const BB_TOOL_POLL_MS = 500;
const RESULT_DELIVERY_ATTEMPTS = 5;
const RESULT_DELIVERY_BACKOFF_MS = [250, 500, 1_000, 2_000];
const RESULT_UNDELIVERABLE = "bb tool outcome is uncertain: the result could not be delivered";
const COMPANION_TURN_ENDED =
  "bb turn ended; bb tools are unavailable to background subagents after their owning turn";
const ORIGIN_UNKNOWN = "bb tool origin could not be established; the call was not run";
const BB_TOOLS_ATTACH_ATTEMPTS = 3;
const TERMINAL_ACTIVITY = new Set([
  "session.tool.success",
  "session.tool.failed",
  "session.execution.interrupted",
  "session.execution.succeeded",
  "session.execution.failed",
]);

export type BbToolHeartbeat = (tick: {
  threadId: string;
  capability: string;
  generation: string;
  epoch: number;
}) => void | Promise<void>;

export interface BbToolHost {
  readonly threadId: string;
  readonly closed: boolean;
  readonly turnOpen: boolean;
  readonly busy: boolean;
  readonly handle: SessionHandle;
  readonly disallowedTools: readonly string[];
  readonly bbToolsRequired: boolean;
  readonly hasDeferredResync: boolean;
  appId(): Promise<string | null>;
  takeoverCapability(): string | undefined;
  rememberCapability(capability: string): Promise<void>;
  secrets(): readonly string[];
  listPlugins(): Promise<unknown>;
  liveTurnId(): string | undefined;
  executionTurnId(): string | undefined;
  warn(message: string): void;
  send(message: unknown): void;
  enqueue(work: () => Promise<void>): Promise<void>;
  durableLog(): Promise<DurableLogRead>;
  emitTurnDeltas(deltas: readonly ThreadDelta[]): Promise<void>;
  settleTurn(outcome: "failed" | "interrupted"): readonly ThreadDelta[];
  reconcileAfterResync(
    sessionID: string,
    messages: readonly OpenCodeSessionMessage[],
  ): readonly ThreadDelta[];
  takeDeferredResync(): readonly OpenCodeSessionMessage[] | undefined;
  setDeferredResync(messages: readonly OpenCodeSessionMessage[] | undefined): void;
}

interface BbToolBinding {
  capability: string;
  generation: string;
  epoch: number;
  catalogDigest: string;
  ownerLeaseMs: number;
  lease: ReturnType<typeof setTimeout> | undefined;
  leaseRenewing: boolean;
  inFlight: Set<string>;
  draining: boolean;
  drainAgain: boolean;
  cancelled: Set<string>;
  seenOpen: Set<string>;
  acknowledged: Set<string>;
  callTurns: Map<string, string>;
  poll: ReturnType<typeof setTimeout> | undefined;
}

type BbReversePhase = "dispatched" | "responded" | "delivering" | "acknowledged" | "uncertain";

interface PendingBbToolCall {
  id: string;
  threadId: string;
  turnId: string;
  key: string;
  phase: BbReversePhase;
  result: BbToolCallResult | undefined;
  companionDelivery: "pending" | "started";
  deliveryAttempts: number;
  nextDeliveryAt: number;
  resolve: () => void;
}

interface ToolState {
  host: BbToolHost;
  descriptors: readonly DynamicTool[] | undefined;
  binding: BbToolBinding | null;
  gate: Promise<void>;
  stale: boolean;
  retired: BbToolBinding | null;
  messageTurns: Map<string, { turnId: string; closed: boolean }>;
  closedTurnIds: Set<string>;
  originRecoveryAuthoritative: boolean;
  originRecoveryIncomplete: boolean;
  publishedBoundaries: Set<string>;
}

type BbToolsHold =
  | { kind: "held" }
  | { kind: "unbound" }
  | { kind: "absent" }
  | { kind: "failed"; error: unknown };

export interface BbToolSession {
  attach(tools: readonly DynamicTool[] | undefined, mode?: "construct" | "turn"): Promise<void>;
  ensure(): Promise<void>;
  pushDisallowed(): Promise<void>;
  onControl(data: Record<string, unknown> | undefined): void;
  noteNative(type: string): void;
  noteExecutionStarted(seq: number | undefined): void;
  noteAssistantMessage(messageID: string, turnId: string): void;
  beginResync(): Promise<void>;
  reconcileUnlessOpen(sessionID: string, messages: readonly OpenCodeSessionMessage[]): Promise<void>;
  consumeBoundary(deltas: readonly ThreadDelta[]): Promise<readonly ThreadDelta[]>;
  abandon(): Promise<void>;
  close(): void;
  capability(): string | undefined;
  forgetOrigins(): void;
  ensurePoll(): void;
}

export interface BbToolCalls {
  bind(host: BbToolHost): BbToolSession;
  handleResponse(response: {
    id: string | number;
    result?: unknown;
    error?: { message?: string };
  }): boolean;
  setIgnoreControl(enabled: boolean): void;
  setHeartbeat(hook: BbToolHeartbeat | undefined): void;
}

export interface CreateBbToolCallsOptions {
  now?: () => number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  leaseStatusTimeoutMs?: number;
}

function clientOf(rpc: BbToolsRpc): BbToolsClient {
  return createBbToolsClient(rpc);
}

function failureResult(text: string): BbToolCallResult {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}

export function createBbToolCalls(options: CreateBbToolCallsOptions = {}): BbToolCalls {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? BB_TOOL_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const leaseStatusTimeoutMs = options.leaseStatusTimeoutMs ?? BB_TOOL_TEARDOWN_RPC_MS;
  const pending = new Map<string, PendingBbToolCall>();
  let serial = 0;
  let ignoreControl = false;
  let heartbeat: BbToolHeartbeat | undefined;

  function bindingStillCurrent(state: ToolState, binding: BbToolBinding): boolean {
    return state.binding === binding;
  }

  function hasRetainedResult(state: ToolState, key: string): boolean {
    for (const call of pending.values()) {
      if (call.threadId !== state.host.threadId || call.key !== key) continue;
      if (call.phase === "acknowledged") continue;
      return true;
    }
    return false;
  }

  function hasOpenCompanionCalls(state: ToolState): boolean {
    const binding = state.binding;
    if (binding === null) return false;
    if (binding.inFlight.size > 0 || binding.draining || binding.seenOpen.size > 0) return true;
    for (const call of pending.values()) {
      if (call.threadId !== state.host.threadId) continue;
      if (call.phase === "acknowledged" || call.phase === "uncertain") continue;
      return true;
    }
    return false;
  }

  function stopLease(binding: BbToolBinding): void {
    if (binding.lease === undefined) return;
    clearTimeout(binding.lease);
    binding.lease = undefined;
  }

  function stopPoll(binding: BbToolBinding): void {
    if (binding.poll === undefined) return;
    clearTimeout(binding.poll);
    binding.poll = undefined;
  }

  function startLease(state: ToolState, binding: BbToolBinding): void {
    stopLease(binding);
    binding.leaseRenewing = false;
    const interval = Math.max(1, Math.floor(binding.ownerLeaseMs / 3));
    const tick = (): void => {
      if (state.host.closed || state.binding !== binding || binding.lease === undefined) {
        binding.lease = undefined;
        return;
      }
      if (!binding.leaseRenewing) {
        binding.leaseRenewing = true;
        void renewLease(state, binding).finally(() => {
          binding.leaseRenewing = false;
        });
      }
      const timer = setTimeout(tick, interval);
      timer.unref?.();
      if (state.binding !== binding) {
        clearTimeout(timer);
        return;
      }
      binding.lease = timer;
    };
    const timer = setTimeout(tick, interval);
    timer.unref?.();
    binding.lease = timer;
  }

  async function renewLease(state: ToolState, binding: BbToolBinding): Promise<void> {
    if (state.binding !== binding || state.host.closed) return;
    try {
      const status = await clientOf(state.host.handle.rpc.bind(state.host.handle)).status(binding.capability, {
        timeoutMs: leaseStatusTimeoutMs,
      });
      if (state.binding !== binding) return;
      if (!status.bound) {
        stopLease(binding);
        state.stale = true;
        return;
      }
      const digestMismatch =
        binding.catalogDigest.length > 0 && status.catalogDigest !== binding.catalogDigest;
      if (status.generation !== binding.generation || digestMismatch) {
        state.stale = true;
      }
    } catch (error) {
      if (isUnboundRpc(error) || (error instanceof BbToolsRpcError && error.kind === "unbound")) {
        stopLease(binding);
        state.stale = true;
        return;
      }
      state.host.warn(diagnostic(state, `bb tool owner heartbeat failed for ${state.host.threadId}: ${failureMessage(error)}`));
    }
  }

  function chooseResult(call: PendingBbToolCall): boolean {
    if (call.phase !== "dispatched") return false;
    call.phase = "responded";
    return true;
  }

  function chooseCancel(call: PendingBbToolCall): boolean {
    if (call.phase !== "dispatched") return false;
    call.phase = "uncertain";
    call.result = failureResult(BB_TOOL_OUTCOME_UNKNOWN);
    return true;
  }

  function beginDelivery(call: PendingBbToolCall): boolean {
    if (call.phase !== "responded") return false;
    call.phase = "delivering";
    return true;
  }

  function sendCancelled(host: BbToolHost, requestId: string): void {
    host.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    });
  }

  function deliveryLost(state: ToolState, binding: BbToolBinding, error: unknown): boolean {
    if (isUnboundRpc(error) || isCompanionAbsent(error)) return true;
    if (error instanceof BbToolsRpcError && (error.kind === "unbound" || error.kind === "absent")) return true;
    return state.binding !== binding && state.binding !== null;
  }

  async function detachCaptured(
    state: ToolState,
    binding: BbToolBinding,
    budgetMs: number,
  ): Promise<void> {
    if (!bindingStillCurrent(state, binding)) return;
    stopPoll(binding);
    stopLease(binding);
    const settled = abandonForwarded(state, binding);
    if (!bindingStillCurrent(state, binding)) return;
    state.retired = binding;
    state.binding = null;
    state.stale = true;
    if (budgetMs <= 0) return;
    const client = clientOf(state.host.handle.rpc.bind(state.host.handle));
    await withTimeout(
      Promise.all([
        settled,
        client.detach({ capability: binding.capability }).catch(() => undefined),
      ]),
      budgetMs,
    ).catch(() => undefined);
  }

  async function deliverCompanionResult(
    state: ToolState,
    binding: BbToolBinding,
    key: string,
    result: BbToolCallResult,
    bound: boolean,
  ): Promise<"acked" | "lost" | "failed" | "conflict" | "too_large"> {
    if (!bound && !bindingStillCurrent(state, binding)) {
      await detachCaptured(state, binding, 0);
      return "lost";
    }
    const client = clientOf(state.host.handle.rpc.bind(state.host.handle));
    try {
      await client.result(
        {
          capability: binding.capability,
          key,
          success: result.success,
          contentItems: result.contentItems,
        },
        { timeoutMs: BB_TOOL_TEARDOWN_RPC_MS },
      );
      return "acked";
    } catch (error) {
      if (error instanceof BbToolsRpcError && error.kind === "conflict") return "conflict";
      if (error instanceof BbToolsRpcError && error.kind === "too_large") return "too_large";
      if (failureMessage(error).includes("conflict")) return "conflict";
      if (deliveryLost(state, binding, error)) {
        state.host.warn(
          diagnostic(state, `could not deliver bb tool result ${key}: ${failureMessage(error)}; not retrying into a new companion generation`),
        );
        await detachCaptured(state, binding, BB_TOOL_TEARDOWN_RPC_MS);
        return "lost";
      }
      state.host.warn(diagnostic(state, `could not deliver bb tool result ${key}: ${failureMessage(error)}`));
      return "failed";
    }
  }

  async function deliverChosen(
    state: ToolState,
    binding: BbToolBinding,
    call: PendingBbToolCall,
    bound: boolean,
  ): Promise<"acked" | "lost" | "failed" | "conflict" | "too_large"> {
    if (call.result === undefined) return "failed";
    if (call.phase === "acknowledged") return "acked";
    if (call.companionDelivery === "started") return "failed";
    call.companionDelivery = "started";
    const outcome = await deliverCompanionResult(state, binding, call.key, call.result, bound);
    if (outcome === "conflict" || outcome === "too_large") return outcome;
    if (outcome === "acked" || outcome === "lost") {
      call.phase = outcome === "acked" ? "acknowledged" : "uncertain";
      if (outcome === "acked") binding.acknowledged.add(call.key);
      pending.delete(call.id);
      return outcome;
    }
    call.companionDelivery = "pending";
    if (call.phase === "delivering") call.phase = "responded";
    return "failed";
  }

  function scheduleResultRetry(state: ToolState, binding: BbToolBinding, call: PendingBbToolCall): void {
    const delay =
      RESULT_DELIVERY_BACKOFF_MS[Math.min(call.deliveryAttempts - 1, RESULT_DELIVERY_BACKOFF_MS.length - 1)] ??
      2_000;
    call.nextDeliveryAt = now() + delay;
    const timer = setTimeout(() => {
      if (bindingStillCurrent(state, binding)) scheduleDrain(state);
    }, delay);
    timer.unref?.();
  }

  async function settleUndeliverable(
    state: ToolState,
    binding: BbToolBinding,
    call: PendingBbToolCall,
  ): Promise<void> {
    state.host.warn(
      `could not deliver bb tool result ${call.key}: undeliverable after ${RESULT_DELIVERY_ATTEMPTS} attempts`,
    );
    call.phase = "uncertain";
    pending.delete(call.id);
    if (!bindingStillCurrent(state, binding)) return;
    const client = clientOf(state.host.handle.rpc.bind(state.host.handle));
    try {
      await client.result(
        {
          capability: binding.capability,
          key: call.key,
          success: false,
          contentItems: [{ type: "inputText", text: RESULT_UNDELIVERABLE }],
        },
        { timeoutMs: BB_TOOL_TEARDOWN_RPC_MS },
      );
      binding.acknowledged.add(call.key);
    } catch (error) {
      if (deliveryLost(state, binding, error) || isCompanionAbsent(error)) {
        state.host.warn(
          diagnostic(state, `could not deliver bb tool result ${call.key}: ${failureMessage(error)}; not retrying into a new companion generation`),
        );
        await detachCaptured(state, binding, BB_TOOL_TEARDOWN_RPC_MS);
      }
    }
  }

  async function finishDelivery(
    state: ToolState,
    binding: BbToolBinding,
    call: PendingBbToolCall,
    bound: boolean,
  ): Promise<void> {
    if (call.companionDelivery === "started") return;
    const outcome = await deliverChosen(state, binding, call, bound);
    if (outcome === "acked" || outcome === "lost") return;
    if (outcome === "conflict" || outcome === "too_large") {
      call.phase = "acknowledged";
      binding.acknowledged.add(call.key);
      pending.delete(call.id);
      return;
    }
    call.deliveryAttempts += 1;
    if (bound || call.deliveryAttempts >= RESULT_DELIVERY_ATTEMPTS) {
      await settleUndeliverable(state, binding, call);
      return;
    }
    scheduleResultRetry(state, binding, call);
  }

  function callBelongsToTurn(binding: BbToolBinding, key: string, turnId: string): boolean {
    return binding.callTurns.get(key) === turnId;
  }

  function settleClaimedUncertain(state: ToolState, key: string): void {
    for (const call of [...pending.values()]) {
      if (call.threadId !== state.host.threadId || call.key !== key) continue;
      if (call.phase === "acknowledged" || call.phase === "uncertain") continue;
      if (call.phase === "dispatched") {
        call.phase = "uncertain";
        call.result = failureResult(BB_TOOL_OUTCOME_UNKNOWN);
        sendCancelled(state.host, call.id);
        call.resolve();
      }
      pending.delete(call.id);
    }
  }

  function cancelReverseCall(state: ToolState, key: string): void {
    for (const call of pending.values()) {
      if (call.threadId !== state.host.threadId || call.key !== key) continue;
      if (!chooseCancel(call)) continue;
      sendCancelled(state.host, call.id);
      call.resolve();
      const binding = state.binding;
      if (binding !== null) void deliverChosen(state, binding, call, true);
    }
  }

  async function abandonForwarded(
    state: ToolState,
    binding: BbToolBinding | null = state.binding,
    turnId?: string,
  ): Promise<void> {
    const scoped = turnId !== undefined;
    if (binding !== null && bindingStillCurrent(state, binding)) {
      for (const key of binding.inFlight) {
        if (!scoped || callBelongsToTurn(binding, key, turnId)) binding.cancelled.add(key);
      }
      for (const key of [...binding.seenOpen]) {
        if (scoped && !callBelongsToTurn(binding, key, turnId)) continue;
        binding.cancelled.add(key);
        if (scoped) binding.seenOpen.delete(key);
      }
      if (!scoped) {
        binding.seenOpen.clear();
        binding.callTurns.clear();
      }
    }
    const deliveries: Promise<void>[] = [];
    for (const call of [...pending.values()]) {
      if (call.threadId !== state.host.threadId) continue;
      if (scoped && call.turnId !== turnId) continue;
      if (!chooseCancel(call)) continue;
      sendCancelled(state.host, call.id);
      call.resolve();
      if (binding !== null) {
        if (scoped) binding.callTurns.delete(call.key);
        deliveries.push(deliverChosen(state, binding, call, true).then(() => undefined));
      }
    }
    await Promise.all(deliveries);
  }

  function ensurePoll(state: ToolState): void {
    const binding = state.binding;
    if (binding === null || binding.poll !== undefined) return;
    const tick = (): void => {
      if (state.host.closed || state.binding !== binding || state.stale) {
        binding.poll = undefined;
        return;
      }
      if (
        !state.host.turnOpen &&
        !state.host.busy &&
        !state.host.hasDeferredResync &&
        !hasOpenCompanionCalls(state)
      ) {
        binding.poll = undefined;
        return;
      }
      if (heartbeat !== undefined) {
        void Promise.resolve()
          .then(() =>
            heartbeat?.({
              threadId: state.host.threadId,
              capability: binding.capability,
              generation: binding.generation,
              epoch: binding.epoch,
            }),
          )
          .catch((error: unknown) => {
            state.host.warn(diagnostic(state, `bb tool owner heartbeat failed for ${state.host.threadId}: ${failureMessage(error)}`));
          });
      }
      scheduleDrain(state);
      binding.poll = setTimeout(tick, pollMs);
      binding.poll.unref?.();
    };
    binding.poll = setTimeout(tick, pollMs);
    binding.poll.unref?.();
  }

  function scheduleDrain(state: ToolState): void {
    const binding = state.binding;
    if (binding === null || state.stale) return;
    if (binding.draining) {
      binding.drainAgain = true;
      return;
    }
    binding.draining = true;
    void (async () => {
      try {
        do {
          binding.drainAgain = false;
          const snapshot = await readPending(state, binding, state.host.hasDeferredResync);
          if (state.host.closed || state.binding !== binding) return;
          if (snapshot === "unbound") {
            for (const key of binding.inFlight) binding.cancelled.add(key);
            for (const key of binding.seenOpen) binding.cancelled.add(key);
            for (const call of [...pending.values()]) {
              if (call.threadId !== state.host.threadId) continue;
              cancelReverseCall(state, call.key);
            }
            binding.inFlight.clear();
            binding.seenOpen.clear();
            await releaseDeferred(state, true);
            return;
          }
          if (snapshot === "failed") {
            if (state.host.hasDeferredResync) {
              binding.inFlight.clear();
              binding.seenOpen.clear();
              await abandonForwarded(state);
              await releaseDeferred(state, true);
            }
            return;
          }
          reconcileSnapshot(state, binding, snapshot);
          await retryRetained(state, binding);
          await releaseDeferred(state, false);
        } while (binding.drainAgain && !state.host.closed && state.binding === binding);
      } catch (error) {
        state.host.warn(diagnostic(state, `could not read pending bb tool calls for ${state.host.threadId}: ${failureMessage(error)}`));
      } finally {
        binding.draining = false;
        if (binding.drainAgain && !state.host.closed && state.binding === binding) {
          scheduleDrain(state);
        }
      }
    })();
  }

  async function readPending(
    state: ToolState,
    binding: BbToolBinding,
    bound: boolean,
  ): Promise<BbToolPendingOutput | "unbound" | "failed"> {
    const acknowledged = [...binding.acknowledged];
    const client = clientOf(state.host.handle.rpc.bind(state.host.handle));
    try {
      const parsed = await client.pending(
        { capability: binding.capability, acknowledged, waitMs: 0 },
        bound ? { timeoutMs: BB_TOOL_TEARDOWN_RPC_MS } : undefined,
      );
      for (const key of acknowledged) binding.acknowledged.delete(key);
      return parsed;
    } catch (error) {
      if (isUnboundRpc(error) || (error instanceof BbToolsRpcError && error.kind === "unbound")) return "unbound";
      state.host.warn(diagnostic(state, `could not read pending bb tool calls for ${state.host.threadId}: ${failureMessage(error)}`));
      return "failed";
    }
  }

  function reconcileSnapshot(state: ToolState, binding: BbToolBinding, snapshot: BbToolPendingOutput): void {
    for (const notice of snapshot.settled ?? []) {
      binding.acknowledged.add(notice.key);
      binding.seenOpen.delete(notice.key);
      binding.inFlight.delete(notice.key);
      if (notice.disposition === "cancelled") cancelReverseCall(state, notice.key);
      if (notice.disposition === "uncertain") settleClaimedUncertain(state, notice.key);
    }
    for (const call of snapshot.calls) {
      if (call.state === "claimed") {
        binding.seenOpen.add(call.key);
        continue;
      }
      if (
        binding.acknowledged.has(call.key) ||
        binding.cancelled.has(call.key) ||
        binding.inFlight.has(call.key) ||
        hasRetainedResult(state, call.key)
      ) {
        continue;
      }
      binding.seenOpen.add(call.key);
      binding.inFlight.add(call.key);
      void runCall(state, binding, call).then(async () => {
        binding.inFlight.delete(call.key);
        binding.callTurns.delete(call.key);
        binding.seenOpen.delete(call.key);
        await releaseDeferred(state, false);
      });
    }
  }

  async function retryRetained(state: ToolState, binding: BbToolBinding): Promise<void> {
    if (!bindingStillCurrent(state, binding)) return;
    for (const call of [...pending.values()]) {
      if (!bindingStillCurrent(state, binding)) return;
      if (call.threadId !== state.host.threadId || call.result === undefined) continue;
      if (now() < call.nextDeliveryAt) continue;
      if (call.phase !== "responded" || call.companionDelivery !== "pending") continue;
      if (!beginDelivery(call)) continue;
      await finishDelivery(state, binding, call, false);
    }
  }

  async function releaseDeferred(state: ToolState, force: boolean): Promise<void> {
    if (!state.host.hasDeferredResync) return;
    if (!force && hasOpenCompanionCalls(state)) return;
    if (!force && (state.host.busy || state.host.turnOpen)) return;
    const messages = state.host.takeDeferredResync();
    if (state.host.turnOpen) {
      await state.host.emitTurnDeltas(state.host.settleTurn("failed"));
      return;
    }
    await state.host.emitTurnDeltas(
      state.host.reconcileAfterResync(state.host.handle.id, messages ?? []),
    );
  }

  function noteMessageTurn(state: ToolState, messageID: string, turnId: string): void {
    const closed = state.closedTurnIds.has(turnId);
    const existing = state.messageTurns.get(messageID);
    if (existing !== undefined && existing.turnId === turnId) {
      existing.closed = existing.closed || closed;
      return;
    }
    state.messageTurns.set(messageID, { turnId, closed });
  }

  function noteTurnClosed(state: ToolState, turnId: string | undefined): void {
    if (turnId === undefined) return;
    state.closedTurnIds.add(turnId);
    for (const entry of state.messageTurns.values()) {
      if (entry.turnId === turnId) entry.closed = true;
    }
  }

  function assistantMessageID(event: OpenCodeNativeEvent): string | undefined {
    const value = event.data?.assistantMessageID;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async function rebuildOrigins(state: ToolState): Promise<void> {
    let events: readonly OpenCodeNativeEvent[];
    try {
      const read = await state.host.durableLog();
      events = read.events;
      state.originRecoveryIncomplete = !read.complete;
      if (!read.complete) {
        state.host.warn(
          `OpenCode session log recovery for ${state.host.threadId} stopped before log.synced; origin recovery is incomplete`,
        );
        return;
      }
    } catch (error) {
      state.originRecoveryIncomplete = true;
      state.host.warn(diagnostic(state, `could not read OpenCode session log for ${state.host.threadId}: ${failureMessage(error)}`));
      return;
    }
    state.originRecoveryIncomplete = false;
    let openTurn: string | undefined;
    for (const event of events) {
      if (event.type === "log.synced") continue;
      const sessionID =
        typeof event.data?.sessionID === "string" ? event.data.sessionID : state.host.handle.id;
      if (sessionID !== state.host.handle.id) continue;
      const seq = event.durable?.seq;
      if (event.type === "session.execution.started") {
        if (openTurn === undefined) openTurn = `exec:${sessionID}:${seq ?? 0}`;
        continue;
      }
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        if (openTurn !== undefined) noteTurnClosed(state, openTurn);
        openTurn = undefined;
        continue;
      }
      const messageID = assistantMessageID(event);
      if (messageID !== undefined && openTurn !== undefined) noteMessageTurn(state, messageID, openTurn);
    }
  }

  function resolveCallTurn(
    state: ToolState,
    call: BbPendingToolCall,
  ): { kind: "live"; turnId: string } | { kind: "closed" } | { kind: "unknown" } {
    if (call.origin.rootSessionID !== state.host.handle.id) return { kind: "unknown" };
    const mapped = state.messageTurns.get(call.origin.rootMessageID);
    if (mapped === undefined) return { kind: "unknown" };
    const live = state.host.liveTurnId();
    if (
      state.host.turnOpen &&
      live === mapped.turnId &&
      !mapped.closed &&
      !state.closedTurnIds.has(mapped.turnId)
    ) {
      return { kind: "live", turnId: mapped.turnId };
    }
    return { kind: "closed" };
  }

  async function rejectCall(
    state: ToolState,
    binding: BbToolBinding,
    key: string,
    message: string,
  ): Promise<void> {
    if (!bindingStillCurrent(state, binding)) return;
    try {
      await clientOf(state.host.handle.rpc.bind(state.host.handle)).reject({
        capability: binding.capability,
        key,
        message,
      });
    } catch (error) {
      if (isUnboundRpc(error) || isCompanionAbsent(error)) return;
      if (error instanceof BbToolsRpcError && (error.kind === "unbound" || error.kind === "absent")) return;
      state.host.warn(diagnostic(state, `could not reject bb tool call ${key}: ${failureMessage(error)}`));
    }
  }

  function forwardCall(
    state: ToolState,
    binding: BbToolBinding,
    call: BbPendingToolCall,
    turnId: string,
  ): Promise<PendingBbToolCall | undefined> {
    if (
      binding.cancelled.has(call.key) ||
      state.host.closed ||
      state.binding !== binding ||
      state.stale
    ) {
      return Promise.resolve(undefined);
    }
    serial += 1;
    const id = `oc-tool-${serial}`;
    return new Promise((resolve) => {
      const entry: PendingBbToolCall = {
        id,
        threadId: state.host.threadId,
        turnId,
        key: call.key,
        phase: "dispatched",
        result: undefined,
        companionDelivery: "pending",
        deliveryAttempts: 0,
        nextDeliveryAt: 0,
        resolve: () => resolve(entry),
      };
      pending.set(id, entry);
      if (
        binding.cancelled.has(call.key) ||
        state.host.closed ||
        state.binding !== binding ||
        state.stale
      ) {
        chooseCancel(entry);
        resolve(entry);
        return;
      }
      state.host.send({
        jsonrpc: "2.0",
        id,
        method: "item/tool/call",
        params: {
          providerThreadId: state.host.handle.id,
          threadId: state.host.threadId,
          turnId,
          callId: call.callID,
          tool: call.tool,
          arguments: call.arguments ?? {},
          providerNativeIds: true,
        },
      });
    });
  }

  async function runCall(state: ToolState, binding: BbToolBinding, call: BbPendingToolCall): Promise<void> {
    if (!bindingStillCurrent(state, binding)) return;
    let resolved = resolveCallTurn(state, call);
    if (resolved.kind === "unknown") {
      await rebuildOrigins(state);
      if (!bindingStillCurrent(state, binding)) return;
      resolved = resolveCallTurn(state, call);
    }
    if (resolved.kind === "unknown") {
      if (state.originRecoveryIncomplete) {
        state.host.warn(`rejecting bb tool call ${call.key}: origin recovery did not reach log.synced`);
      }
      await rejectCall(state, binding, call.key, ORIGIN_UNKNOWN);
      return;
    }
    if (resolved.kind === "closed") {
      await rejectCall(state, binding, call.key, COMPANION_TURN_ENDED);
      return;
    }
    if (!bindingStillCurrent(state, binding)) return;
    binding.callTurns.set(call.key, resolved.turnId);
    try {
      await clientOf(state.host.handle.rpc.bind(state.host.handle)).claim({
        capability: binding.capability,
        key: call.key,
      });
    } catch (error) {
      binding.callTurns.delete(call.key);
      state.host.warn(diagnostic(state, `could not claim bb tool call ${call.key}: ${failureMessage(error)}`));
      return;
    }
    if (!bindingStillCurrent(state, binding)) return;
    const again = resolveCallTurn(state, call);
    if (again.kind !== "live") {
      binding.callTurns.delete(call.key);
      await deliverCompanionResult(state, binding, call.key, failureResult(COMPANION_TURN_ENDED), false);
      return;
    }
    if (binding.cancelled.has(call.key) || state.host.closed || state.stale) {
      await deliverCompanionResult(
        state,
        binding,
        call.key,
        failureResult(BB_TOOL_OUTCOME_UNKNOWN),
        state.host.closed || !bindingStillCurrent(state, binding),
      );
      return;
    }
    const forwarded = await forwardCall(state, binding, call, again.turnId);
    if (forwarded === undefined || forwarded.result === undefined) return;
    if (forwarded.phase === "uncertain") {
      await deliverChosen(state, binding, forwarded, true);
      return;
    }
    if (forwarded.phase !== "responded" || !beginDelivery(forwarded)) return;
    await finishDelivery(state, binding, forwarded, false);
    await releaseDeferred(state, false);
  }

  async function rejectUnresolved(state: ToolState): Promise<void> {
    const binding = state.binding;
    if (binding === null || !state.originRecoveryAuthoritative) return;
    const snapshot = await readPending(state, binding, true);
    if (!bindingStillCurrent(state, binding) || snapshot === "unbound" || snapshot === "failed") return;
    for (const call of snapshot.calls) {
      if (call.state === "claimed") continue;
      if (resolveCallTurn(state, call).kind !== "unknown") continue;
      binding.seenOpen.delete(call.key);
      binding.inFlight.delete(call.key);
      await rejectCall(state, binding, call.key, ORIGIN_UNKNOWN);
    }
  }

  function mappedToOpenExecution(state: ToolState, messageID: string): boolean {
    const mapped = state.messageTurns.get(messageID);
    if (mapped === undefined || mapped.closed || state.closedTurnIds.has(mapped.turnId)) return false;
    return state.host.turnOpen && state.host.liveTurnId() === mapped.turnId;
  }

  async function rejectUnclaimedOfTurn(
    state: ToolState,
    binding: BbToolBinding,
    turnId: string | undefined,
  ): Promise<void> {
    if (!bindingStillCurrent(state, binding)) return;
    await rebuildOrigins(state);
    if (!bindingStillCurrent(state, binding)) return;
    const snapshot = await readPending(state, binding, true);
    if (!bindingStillCurrent(state, binding) || snapshot === "unbound" || snapshot === "failed") return;
    for (const call of snapshot.calls) {
      if (call.state === "claimed") continue;
      if (call.origin.rootSessionID !== state.host.handle.id) continue;
      const mapped = state.messageTurns.get(call.origin.rootMessageID);
      const captured = binding.callTurns.get(call.key);
      if (turnId === undefined || (mapped?.turnId !== turnId && captured !== turnId)) continue;
      if (mappedToOpenExecution(state, call.origin.rootMessageID)) continue;
      binding.seenOpen.delete(call.key);
      binding.inFlight.delete(call.key);
      binding.callTurns.delete(call.key);
      await rejectCall(
        state,
        binding,
        call.key,
        mapped === undefined ? ORIGIN_UNKNOWN : COMPANION_TURN_ENDED,
      );
      if (!bindingStillCurrent(state, binding)) return;
    }
  }

  async function settleClosedTurn(
    state: ToolState,
    binding: BbToolBinding | null,
    turnId: string | undefined,
  ): Promise<void> {
    if (turnId === undefined || binding === null) {
      if (turnId !== undefined) noteTurnClosed(state, turnId);
      return;
    }
    noteTurnClosed(state, turnId);
    await abandonForwarded(state, binding, turnId);
    if (bindingStillCurrent(state, binding)) await rejectUnclaimedOfTurn(state, binding, turnId);
  }

  function closesOwnedTurn(state: ToolState, deltas: readonly ThreadDelta[]): boolean {
    return deltas.some((delta) => {
      if (delta.kind !== "turn.boundary") return false;
      if ("parentRef" in delta && delta.parentRef !== undefined) return false;
      const turnId = "providerTurnId" in delta ? delta.providerTurnId : undefined;
      return turnId === undefined || turnId === state.host.liveTurnId();
    });
  }

  function explicitRootBoundaryId(deltas: readonly ThreadDelta[]): string | undefined {
    for (const delta of deltas) {
      if (delta.kind !== "turn.boundary") continue;
      if ("parentRef" in delta && delta.parentRef !== undefined) continue;
      if ("providerTurnId" in delta && typeof delta.providerTurnId === "string") return delta.providerTurnId;
    }
    return undefined;
  }

  function withoutRootBoundary(deltas: readonly ThreadDelta[], turnId: string): ThreadDelta[] {
    return deltas.filter((delta) => {
      if (delta.kind !== "turn.boundary") return true;
      if ("parentRef" in delta && delta.parentRef !== undefined) return true;
      return delta.providerTurnId !== turnId;
    });
  }

  function closingRootTurnId(state: ToolState, deltas: readonly ThreadDelta[]): string | undefined {
    if (!closesOwnedTurn(state, deltas)) return undefined;
    return explicitRootBoundaryId(deltas) ?? state.host.liveTurnId();
  }

  function reachError(state: ToolState, error: unknown): BbToolsSetupError {
    return new BbToolsSetupError(
      diagnostic(
        state,
        `OpenCode companion ${BB_TOOLS_RPC} could not be reached (${failureMessage(error)}). Retry the turn; bb tools were not dropped.`,
      ),
    );
  }

  async function readHold(
    state: ToolState,
    binding: BbToolBinding,
    generation: string,
    hello: BbToolsHello,
  ): Promise<BbToolsHold> {
    if (hello.kind !== "ok") return { kind: "unbound" };
    if (binding.generation !== generation) return { kind: "unbound" };
    try {
      const status = await clientOf(state.host.handle.rpc.bind(state.host.handle)).status(binding.capability);
      if (status.bound && status.generation === generation && status.epoch === binding.epoch) {
        if (binding.catalogDigest.length > 0 && status.catalogDigest !== binding.catalogDigest) {
          return { kind: "unbound" };
        }
        return { kind: "held" };
      }
      return { kind: "unbound" };
    } catch (error) {
      return classifyBbToolsRpcError(error) === "absent" ? { kind: "absent" } : { kind: "failed", error };
    }
  }

  function bindingFrom(
    output: { capability: string; generation: string; epoch: number; catalogDigest: string; ownerLeaseMs: number },
    limits: BbToolsLimits,
  ): BbToolBinding {
    return {
      capability: output.capability,
      generation: output.generation,
      epoch: output.epoch,
      catalogDigest: output.catalogDigest,
      ownerLeaseMs: output.ownerLeaseMs > 0 ? output.ownerLeaseMs : limits.ownerLeaseMs,
      lease: undefined,
      leaseRenewing: false,
      inFlight: new Set(),
      draining: false,
      drainAgain: false,
      cancelled: new Set(),
      seenOpen: new Set(),
      acknowledged: new Set(),
      callTurns: new Map(),
      poll: undefined,
    };
  }

  function catalogOf(tools: readonly DynamicTool[]) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  function invalidToolReports(error: unknown): Array<{ tool?: string; reason: string; detail: string }> {
    if (!(error instanceof BbToolsRpcError) || error.code !== "invalid" || !Array.isArray(error.data.tools)) {
      return [];
    }
    const reports: Array<{ tool?: string; reason: string; detail: string }> = [];
    for (const item of error.data.tools) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.reason !== "string" || typeof record.detail !== "string") continue;
      reports.push({
        ...(typeof record.tool === "string" ? { tool: record.tool } : {}),
        reason: record.reason,
        detail: record.detail,
      });
    }
    return reports;
  }

  class OwnerActiveWait extends Error {
    readonly retryAfterMs: number;
    readonly leaseMs: number;

    constructor(retryAfterMs: number, leaseMs: number) {
      super("owner lease is active");
      this.name = "OwnerActiveWait";
      this.retryAfterMs = retryAfterMs;
      this.leaseMs = leaseMs;
    }
  }

  function diagnostic(state: ToolState, text: string, extra: readonly string[] = []): string {
    return redactCompanionSecrets(text, [...state.host.secrets(), ...extra]);
  }

  function ownerActiveMessage(retryAfterMs: number): string {
    return `OpenCode companion owner lease is active. A restarted bridge must present its saved capability; a second bridge without that proof cannot attach for another ${retryAfterMs}ms. Stop the other bridge or retry the turn after the lease expires.`;
  }

  async function duplicateAttachmentError(state: ToolState, instances: number): Promise<string | null> {
    if (instances <= 1) return null;
    let plugins: ReturnType<typeof companionPluginSpecsFrom>;
    try {
      plugins = companionPluginSpecsFrom(await state.host.listPlugins());
    } catch (error) {
      plugins = { kind: "failed", message: diagnostic(state, failureMessage(error)) };
    }
    return duplicateCompanionAttachmentMessage({
      instances,
      specs: plugins.kind === "ok" ? plugins.specs : [],
      pluginListError: plugins.kind === "failed" ? plugins.message : null,
    });
  }

  function overloadedMessage(error: BbToolsRpcError): string {
    const limit = typeof error.data.limit === "number" ? error.data.limit : DEFAULT_BB_TOOLS_LIMITS.maxBindings;
    return `OpenCode companion cannot accept another binding (limit ${limit}). Detach another bb session in this directory, then retry the turn.`;
  }

  async function install(
    state: ToolState,
    tools: readonly DynamicTool[],
    limits: BbToolsLimits,
    warnDropped: (dropped: readonly { name: string; reason: string; detail: string }[]) => void,
  ): Promise<BbToolBinding> {
    const client = clientOf(state.host.handle.rpc.bind(state.host.handle));
    const takeover = state.host.takeoverCapability();
    let catalog = [...tools];
    let droppedInvalid = false;
    for (;;) {
      try {
        const output = await client.attach({
          sessionID: state.host.handle.id,
          bbThreadId: state.host.threadId,
          disallowedTools: state.host.disallowedTools,
          tools: catalogOf(catalog),
          ...(takeover === undefined ? {} : { takeover: { capability: takeover } }),
        });
        await state.host.rememberCapability(output.capability);
        return bindingFrom(output, limits);
      } catch (error) {
        if (error instanceof BbToolsRpcError && error.kind === "owner_active") {
          const retryAfter = typeof error.data.retryAfterMs === "number" ? Math.max(0, error.data.retryAfterMs) : limits.ownerLeaseMs;
          if (retryAfter <= 0) throw new BbToolsSetupError(ownerActiveMessage(retryAfter));
          throw new OwnerActiveWait(retryAfter, limits.ownerLeaseMs);
        }
        if (error instanceof BbToolsRpcError && error.kind === "overloaded") {
          throw new BbToolsSetupError(overloadedMessage(error));
        }
        const reports = invalidToolReports(error);
        if (!droppedInvalid && reports.length > 0) {
          droppedInvalid = true;
          const named = reports.filter((item): item is { tool: string; reason: string; detail: string } => item.tool !== undefined);
          warnDropped(named.map((item) => ({ name: item.tool, reason: item.reason, detail: item.detail })));
          const drop = new Set(named.map((item) => item.tool));
          catalog = catalog.filter((tool) => !drop.has(tool.name));
          if (catalog.length === 0) throw error;
          continue;
        }
        throw error;
      }
    }
  }

  function withLock<T>(state: ToolState, body: () => Promise<T>): Promise<T> {
    const run = state.gate.then(body, body);
    state.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function retire(state: ToolState, binding: BbToolBinding): Promise<void> {
    stopPoll(binding);
    stopLease(binding);
    if (state.binding === binding) await abandonForwarded(state);
  }

  function bind(rawHost: BbToolHost): BbToolSession {
    const host: BbToolHost = new Proxy(rawHost, {
      get(target, prop, receiver) {
        if (prop === "warn") {
          return (message: string) => rawHost.warn(redactCompanionSecrets(message, rawHost.secrets()));
        }
        if (prop === "send") {
          return (message: unknown) => rawHost.send(redactCompanionSecrets(message, rawHost.secrets()));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const state: ToolState = {
      host,
      descriptors: undefined,
      binding: null,
      gate: Promise.resolve(),
      stale: false,
      retired: null,
      messageTurns: new Map(),
      closedTurnIds: new Set(),
      originRecoveryAuthoritative: false,
      originRecoveryIncomplete: false,
      publishedBoundaries: new Set(),
    };
    let warned = false;
    async function warnAbsent(tools: readonly { name: string }[], mode: "construct" | "turn"): Promise<void> {
      if (host.bbToolsRequired) {
        if (mode === "turn") {
          throw new BbToolsSetupError(bbToolsRequiredSetupMessage(await host.appId()));
        }
        return;
      }
      if (warned || tools.length === 0) return;
      warned = true;
      host.send({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: host.threadId,
          deltas: [
            {
              kind: "provider.warning",
              summary: ABSENT_COMPANION_WARNING_SUMMARY,
              details: absentCompanionWarningDetails({
                toolNames: tools.map((tool) => tool.name),
                appId: await host.appId(),
              }),
            },
          ],
        },
      });
    }
    function warnOnce(tools: readonly { name: string }[], reason: string): void {
      if (warned || tools.length === 0) return;
      warned = true;
      host.send({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: host.threadId,
          deltas: [
            {
              kind: "provider.warning",
              summary: ABSENT_COMPANION_WARNING_SUMMARY,
              details: `Dropped dynamicTools: ${tools.map((tool) => tool.name).join(", ")} (${reason})`,
            },
          ],
        },
      });
    }
    async function syncOutsideWait(
      mode: "construct" | "turn",
      warnTools: (tools: readonly DynamicTool[], reason: string) => void,
      run: (body: () => Promise<void>) => Promise<void>,
    ): Promise<void> {
      const started = now();
      for (;;) {
        let deferral: OwnerActiveWait | undefined;
        await run(async () => {
          try {
            await syncWithWarning(state, mode, warnTools);
          } catch (error) {
            if (error instanceof OwnerActiveWait) {
              deferral = error;
              return;
            }
            throw error;
          }
        });
        if (deferral === undefined) return;
        const elapsed = now() - started;
        if (state.host.closed || elapsed + deferral.retryAfterMs > deferral.leaseMs) {
          throw new BbToolsSetupError(ownerActiveMessage(deferral.retryAfterMs));
        }
        await sleep(deferral.retryAfterMs);
      }
    }
    function warnDropped(dropped: readonly { name: string; reason: string; detail: string }[]): void {
      if (dropped.length === 0) return;
      host.send({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: host.threadId,
          deltas: [
            {
              kind: "provider.warning",
              summary: "Dropped invalid bb tools",
              details: dropped.map((item) => `${item.name} (${item.reason}: ${item.detail})`).join("; "),
            },
          ],
        },
      });
    }
    const session: BbToolSession = {
      attach(tools, mode = "construct") {
        state.descriptors = tools;
        return syncOutsideWait(mode, (list, reason) => warnOnce(list, reason), (body) => withLock(state, body));
      },
      ensure() {
        return syncOutsideWait("turn", (list, reason) => warnOnce(list, reason), (body) =>
          host.enqueue(() => withLock(state, body)),
        );
      },
      async pushDisallowed() {
        const binding = state.binding;
        if (binding === null) return;
        await clientOf(host.handle.rpc.bind(host.handle)).configure(
          { capability: binding.capability, disallowedTools: host.disallowedTools },
          { timeoutMs: BB_TOOL_TEARDOWN_RPC_MS },
        );
        if (!bindingStillCurrent(state, binding)) return;
      },
      onControl(data) {
        if (ignoreControl) return;
        const key = typeof data?.key === "string" ? data.key : undefined;
        if (data?.type === "pending" && key !== undefined) state.binding?.seenOpen.add(key);
        if (data?.type === "cancelled" && key !== undefined) {
          state.binding?.cancelled.add(key);
          state.binding?.seenOpen.delete(key);
          cancelReverseCall(state, key);
        }
        scheduleDrain(state);
        ensurePoll(state);
      },
      noteNative(type) {
        if (!TERMINAL_ACTIVITY.has(type)) return;
        scheduleDrain(state);
        ensurePoll(state);
      },
      noteExecutionStarted(seq) {
        if (
          typeof seq === "number" &&
          `exec:${host.handle.id}:${seq}` !== host.liveTurnId()
        ) {
          state.originRecoveryAuthoritative = false;
        }
      },
      noteAssistantMessage(messageID, turnId) {
        const previous = state.messageTurns.get(messageID)?.turnId;
        noteMessageTurn(state, messageID, turnId);
        if (previous !== turnId) scheduleDrain(state);
      },
      async beginResync() {
        state.originRecoveryAuthoritative = true;
        await rebuildOrigins(state);
        await rejectUnresolved(state);
        scheduleDrain(state);
        ensurePoll(state);
      },
      reconcileUnlessOpen(sessionID, messages) {
        if (sessionID === host.handle.id && hasOpenCompanionCalls(state)) {
          host.setDeferredResync(messages);
          host.warn(`skipping OpenCode resync reconcile for ${host.threadId}: bb tool call still open`);
          ensurePoll(state);
          return Promise.resolve();
        }
        host.setDeferredResync(undefined);
        return host.emitTurnDeltas(host.reconcileAfterResync(sessionID, messages));
      },
      async consumeBoundary(deltas) {
        const binding = state.binding;
        const boundaryId = explicitRootBoundaryId(deltas);
        const live = host.liveTurnId();
        if (boundaryId !== undefined && live !== undefined && live !== boundaryId) {
          await settleClosedTurn(state, binding, boundaryId);
          if (state.publishedBoundaries.has(boundaryId)) {
            host.warn(`dropping stale turn boundary ${boundaryId} for ${host.threadId}; live turn is ${live}`);
            return withoutRootBoundary(deltas, boundaryId);
          }
          host.warn(`publishing late turn boundary ${boundaryId} for ${host.threadId}; live turn is ${live}`);
          state.publishedBoundaries.add(boundaryId);
          return deltas;
        }
        const turnId = closingRootTurnId(state, deltas);
        if (closesOwnedTurn(state, deltas)) {
          await settleClosedTurn(state, binding, turnId);
          if (turnId !== undefined) state.publishedBoundaries.add(turnId);
          if (binding === null || bindingStillCurrent(state, binding)) {
            host.setDeferredResync(undefined);
          }
        }
        return deltas;
      },
      abandon: () => abandonForwarded(state),
      close() {
        const binding = state.binding;
        state.binding = null;
        if (binding === null) return;
        stopPoll(binding);
        stopLease(binding);
        void withTimeout(
          clientOf(host.handle.rpc.bind(host.handle))
            .detach({ capability: binding.capability })
            .catch(() => undefined),
          BB_TOOL_TEARDOWN_RPC_MS,
        ).catch(() => undefined);
      },
      capability: () => state.binding?.capability,
      forgetOrigins() {
        state.messageTurns.clear();
        state.closedTurnIds.clear();
      },
      ensurePoll: () => ensurePoll(state),
    };

    async function syncWithWarning(
      current: ToolState,
      mode: "construct" | "turn",
      warnTools: (tools: readonly DynamicTool[], reason: string) => void,
    ): Promise<void> {
      const previous = current.binding ?? current.retired;
      if (current.stale) {
        const binding = current.binding;
        if (binding !== null) await detachCaptured(current, binding, BB_TOOL_TEARDOWN_RPC_MS);
        current.stale = false;
      }
      const tools = current.descriptors;
      if (tools === undefined || tools.length === 0) return;
      for (let attempt = 0; attempt < BB_TOOLS_ATTACH_ATTEMPTS; attempt += 1) {
        const hello = await clientOf(current.host.handle.rpc.bind(current.host.handle)).hello();
        if (hello.kind === "absent") {
          const live = current.binding;
          if (live !== null) await retire(current, live);
          current.binding = null;
          await warnAbsent(tools, mode);
          return;
        }
        if (hello.kind === "failed") {
          if (mode === "turn") throw reachError(current, hello.error);
          return;
        }
        if (hello.kind === "rejected") {
          const live = current.binding;
          if (live !== null) await retire(current, live);
          current.binding = null;
          if (mode === "turn") throw new BbToolsSetupError(hello.message);
          return;
        }
        const duplicate = await duplicateAttachmentError(current, hello.instances);
        if (duplicate !== null) {
          const bound = current.binding;
          if (bound !== null) await retire(current, bound);
          current.binding = null;
          throw new BbToolsSetupError(duplicate);
        }
        const live = current.binding;
        if (live !== null) {
          const held = await readHold(current, live, hello.generation, hello);
          if (held.kind === "held") {
            if (live.lease === undefined) startLease(current, live);
            return;
          }
          if (held.kind === "absent") {
            await retire(current, live);
            current.binding = null;
            await warnAbsent(tools, mode);
            return;
          }
          if (held.kind === "failed") {
            if (mode === "turn") throw reachError(current, held.error);
            return;
          }
        }
        let installed: BbToolBinding;
        try {
          installed = await install(current, tools, hello.limits, warnDropped);
        } catch (error) {
          if (
            error instanceof OwnerActiveWait ||
            error instanceof BbToolsSetupError ||
            error instanceof OpenCodeUnauthenticatedError
          ) {
            throw error;
          }
          if (isCompanionAbsent(error)) {
            const bound = current.binding;
            if (bound !== null) await retire(current, bound);
            current.binding = null;
            await warnAbsent(tools, mode);
            return;
          }
          if (mode === "turn" && attempt + 1 === BB_TOOLS_ATTACH_ATTEMPTS) {
            throw new BbToolsSetupError(
              diagnostic(
                current,
                `OpenCode companion is installed but bb tools could not be reattached: ${failureMessage(error)}. Install a compatible opencode-bb-tools release with the engine's \`plugin add opencode-bb-tools\` and retry the turn.`,
              ),
            );
          }
          if (mode === "construct" && attempt + 1 === BB_TOOLS_ATTACH_ATTEMPTS) {
            warnTools(tools, diagnostic(current, failureMessage(error)));
            return;
          }
          continue;
        }
        if (installed.generation !== hello.generation) continue;
        const confirmed = await readHold(current, installed, installed.generation, hello);
        if (confirmed.kind === "held") {
          if (previous !== null && previous !== installed) await retire(current, previous);
          current.binding = installed;
          current.retired = null;
          if (previous !== null && previous !== installed) {
            current.host.warn(
              `reattached bb tools for ${current.host.threadId}: generation ${previous.generation} -> ${installed.generation}`,
            );
          }
          startLease(current, installed);
          if (current.host.turnOpen || current.host.busy || current.host.hasDeferredResync) {
            ensurePoll(current);
          }
          return;
        }
        if (confirmed.kind === "absent") {
          const bound = current.binding;
          if (bound !== null) await retire(current, bound);
          current.binding = null;
          await warnAbsent(tools, mode);
          return;
        }
        if (confirmed.kind === "failed") {
          if (mode === "turn") throw reachError(current, confirmed.error);
          return;
        }
      }
      if (mode === "turn") {
        throw new BbToolsSetupError(
          `OpenCode companion ${BB_TOOLS_RPC} generation changed before the binding could be confirmed. Retry the turn.`,
        );
      }
    }

    return session;
  }

  return {
    bind,
    handleResponse(response) {
      const id = String(response.id);
      const call = pending.get(id);
      if (call === undefined || !chooseResult(call)) return call !== undefined;
      if ("error" in response && response.error !== undefined) {
        call.result = {
          success: false,
          contentItems: [{ type: "inputText", text: response.error.message ?? "bb tool call failed" }],
        };
      } else {
        const parsed = bbToolCallResultSchema.safeParse(response.result);
        call.result = parsed.success
          ? parsed.data
          : {
              success: false,
              contentItems: [{ type: "inputText", text: "bb returned an invalid tool result" }],
            };
      }
      call.resolve();
      return true;
    },
    setIgnoreControl(enabled) {
      ignoreControl = enabled;
    },
    setHeartbeat(hook) {
      heartbeat = hook;
    },
  };
}
