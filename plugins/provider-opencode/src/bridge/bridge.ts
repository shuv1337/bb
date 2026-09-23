import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  type InitializeResult,
  type PendingInteractionPayload,
  type ProviderBridgeContext,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { toAvailableModels } from "../models.js";
import { createOpenCodeDeltaTranslator } from "../delta-translation.js";
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
  resolvePlanExitAgentId,
  type OpenCodeModel,
  type OpenCodeNativeEvent,
  type OpenCodeRuntime,
  type RuntimeSessionEvent,
  type SessionHandle,
} from "../runtime/index.js";
import {
  getOpenCodeProviderHealth,
  getOpenCodeProviderInstallationRun,
  getOpenCodeProviderInstallationStatus,
} from "./provider-maintenance.js";

const UNOPENED_DISPATCH_GRACE_MS = 250;

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
}

type OwnerRecord = { threadId: string; cwd: string };

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
  planActive: boolean;
  busy: boolean;
  warnedTools: boolean;
  work: Promise<void>;
  childHandles: Map<string, SessionHandle>;
  catalog: OpenCodeModel[];
  turnOpen: boolean;
  liveProviderTurnId: string | undefined;
  pendingAccepts: Array<{
    clientRequestId: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
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

function bbThreadIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.bbThreadId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createOpenCodeBridge(deps: OpenCodeBridgeDeps = {}) {
  const { send, sendResult, sendError } = createBridgeIo();
  const translator = createOpenCodeDeltaTranslator();
  const sessions = new Map<string, ThreadSession>();
  const sessionsByProviderId = new Map<string, ThreadSession>();
  const pendingInteractions = new Map<string, PendingInteraction>();
  const owners = new Map<string, OwnerRecord>();
  let runtimePromise: Promise<OpenCodeRuntime> | null = null;
  let ownersPath: string | null = null;
  let interactionSerial = 0;
  let zeroWorkSerial = 0;
  let closed = false;

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

  function sendDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
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

  function acceptDispatch(
    session: ThreadSession,
    clientRequestId: string,
    zeroWork: boolean,
    providerTurnId?: string,
  ): void {
    if (session.closed) return;
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
      sendDeltas(session.threadId, [
        { kind: "turn.open", providerTurnId: settledId },
        { kind: "input.accepted", clientRequestId, providerTurnId: settledId },
        { kind: "turn.boundary", providerTurnId: settledId, status: "completed" },
      ]);
    }, UNOPENED_DISPATCH_GRACE_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  function surfaceStreamFailure(session: ThreadSession, error: unknown): void {
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
    sendDeltas(session.threadId, deltas);
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
          owners.set(sessionID, {
            threadId: (record as OwnerRecord).threadId,
            cwd: (record as OwnerRecord).cwd,
          });
        }
      }
    } catch {
      return;
    }
  }

  function persistOwners(): void {
    if (ownersPath === null) {
      return;
    }
    writeFileSync(
      ownersPath,
      JSON.stringify(Object.fromEntries(owners.entries())),
      "utf8",
    );
  }

  function rememberOwner(sessionID: string, threadId: string, cwd: string): void {
    owners.set(sessionID, { threadId, cwd });
    persistOwners();
  }

  async function runtime(): Promise<OpenCodeRuntime> {
    if (runtimePromise === null) {
      runtimePromise = deps.createRuntime
        ? deps.createRuntime()
        : createOpenCodeRuntime();
    }
    return runtimePromise;
  }

  function enqueue(session: ThreadSession, work: () => Promise<void>): Promise<void> {
    session.work = session.work.then(work, work);
    return session.work;
  }

  function handleForEvent(session: ThreadSession, sessionID: string): SessionHandle {
    if (sessionID === session.handle.id) {
      return session.handle;
    }
    const child = session.childHandles.get(sessionID);
    return child ?? session.handle;
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
    if (wrapped.kind === "resync") {
      const messages = await session.handle.context();
      sendDeltas(
        session.threadId,
        translator.reconcileAfterResync(session.handle.id, messages),
      );
      return;
    }
    const native: OpenCodeNativeEvent = wrapped.event;
    if (
      wrapped.sessionID === session.handle.id &&
      PROVIDER_ACTIVITY.has(native.type)
    ) {
      noteProviderActivity(session);
    }
    if (
      wrapped.parentID === session.handle.id &&
      wrapped.sessionID !== session.handle.id &&
      !session.childHandles.has(wrapped.sessionID)
    ) {
      try {
        const child = await (await runtime()).openSession(wrapped.sessionID);
        session.childHandles.set(wrapped.sessionID, child);
      } catch {
        return;
      }
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
    if (translated.gap) {
      const messages = await handleForEvent(session, wrapped.sessionID).context();
      sendDeltas(
        session.threadId,
        translator.reconcileAfterResync(wrapped.sessionID, messages),
      );
    }
    sendDeltas(session.threadId, translated.deltas);
    for (const interaction of translated.interactions) {
      const handle = handleForEvent(session, interaction.sessionID);
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
    if (wrapped.sessionID !== session.handle.id) {
      return;
    }
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

  function startPump(session: ThreadSession, ocRuntime: OpenCodeRuntime): void {
    const run = async () => {
      while (!session.closed && !session.abort.signal.aborted) {
        try {
          for await (const event of ocRuntime.subscribe(
            session.handle.id,
            session.abort.signal,
          )) {
            if (session.closed) return;
            try {
              await enqueue(session, () => applyRuntimeEvent(session, event));
            } catch (error) {
              if (session.closed || session.abort.signal.aborted) return;
              const message = failureMessage(error);
              const liveTurnId = liveTurnIdOf(session);
              sendDeltas(session.threadId, [
                {
                  kind: "provider.error",
                  message,
                  ...(session.turnOpen && liveTurnId !== undefined
                    ? { providerTurnId: liveTurnId }
                    : session.turnOpen
                      ? {}
                      : { threadScoped: true }),
                },
              ]);
            }
            if (session.closed) {
              return;
            }
          }
        } catch (error) {
          if (session.closed || session.abort.signal.aborted) return;
          surfaceStreamFailure(session, error);
          return;
        }
        if (session.closed) {
          return;
        }
      }
    };
    void run();
  }

  async function applyKnobs(session: ThreadSession, knobs: AppliedSessionKnobs): Promise<void> {
    session.persistApprovals = knobs.persistApprovals;
    if (knobs.instructions !== null) {
      await session.handle.setInstructions(knobs.instructions);
    }
    await session.handle.setEnvironment(knobs.env);
    await session.handle.update({ permissions: knobs.permissions });
    if (knobs.model !== undefined) {
      await session.handle.switchModel(knobs.model);
    }
    if (knobs.agent === "plan") {
      await session.handle.switchAgent("plan");
      session.planActive = true;
      return;
    }
    if (session.planActive) {
      const catalog = await (await runtime()).agents(session.handle.location);
      const restored = resolvePlanExitAgentId({
        settingDefaultAgent: knobs.agent,
        agents: catalog.agents,
        configDefaultAgent: catalog.defaultAgentId,
      });
      if (restored !== null) {
        await session.handle.switchAgent(restored);
      }
      session.planActive = false;
      return;
    }
    if (knobs.agent !== null) {
      await session.handle.switchAgent(knobs.agent);
    }
  }

  function warnDroppedTools(
    session: ThreadSession,
    tools: readonly { name: string }[] | undefined,
  ): void {
    if (session.warnedTools || tools === undefined || tools.length === 0) {
      return;
    }
    session.warnedTools = true;
    sendDeltas(session.threadId, [
      {
        kind: "provider.warning",
        summary: "OpenCode does not run bb plugin tools",
        details: `Dropped dynamicTools: ${tools.map((tool) => tool.name).join(", ")}`,
      },
    ]);
  }

  function registerSession(threadId: string, handle: SessionHandle, cwd: string): ThreadSession {
    const existing = sessions.get(threadId);
    if (existing !== undefined) {
      void detachSession(existing);
    }
    const session: ThreadSession = {
      threadId,
      handle,
      cwd,
      abort: new AbortController(),
      closed: false,
      persistApprovals: false,
      planActive: false,
      busy: false,
      warnedTools: false,
      work: Promise.resolve(),
      childHandles: new Map(),
      catalog: [],
      turnOpen: false,
      liveProviderTurnId: undefined,
      pendingAccepts: [],
    };
    sessions.set(threadId, session);
    sessionsByProviderId.set(handle.id, session);
    rememberOwner(handle.id, threadId, cwd);
    return session;
  }

  async function detachSession(session: ThreadSession): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    clearPendingAccept(session);
    prunePendingInteractions(session.threadId);
    session.abort.abort();
    sessions.delete(session.threadId);
    sessionsByProviderId.delete(session.handle.id);
    await session.work.catch(() => undefined);
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

  async function assertOwned(
    handle: SessionHandle,
    threadId: string,
    cwd: string,
  ): Promise<void> {
    const info = await handle.info();
    const mapped = owners.get(handle.id);
    const metadataId = bbThreadIdFromMetadata(info.metadata);
    if (mapped !== undefined) {
      if (mapped.threadId !== threadId) {
        throw new Error(
          `OpenCode session ${handle.id} belongs to thread ${mapped.threadId}, not ${threadId}`,
        );
      }
      if (mapped.cwd !== cwd) {
        throw new Error(
          `OpenCode session ${handle.id} is bound to ${mapped.cwd}, not ${cwd}`,
        );
      }
      return;
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
    if (info.location.directory !== cwd && info.location.directory.length > 0) {
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

  async function handleRequest(
    request: OpenCodeCommand & { id: string | number },
  ): Promise<void> {
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
        const directory = request.params.cwd ?? process.cwd();
        const models = await oc.models({ directory });
        sendResult(request.id, {
          models: toAvailableModels({ models }).map((model) => {
            const { routeProviderId: _route, ...rest } = model;
            return rest;
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
        sendResult(request.id, await getOpenCodeProviderInstallationStatus());
        break;
      }
      case "provider/installation/run": {
        sendResult(
          request.id,
          await getOpenCodeProviderInstallationRun(request.params.action),
        );
        break;
      }
      case "thread/start": {
        const catalog = await catalogFor(request.params.cwd);
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: request.params.instructionMode,
          catalog,
        });
        const oc = await runtime();
        await assertRequestedAgent(request.params.cwd, knobs.agent);
        const handle = await oc.createSession({
          location: { directory: request.params.cwd },
          title: sessionTitleForThread(request.params.threadId),
          ...(knobs.agent !== null ? { agent: knobs.agent } : {}),
          ...(knobs.model !== undefined ? { model: knobs.model } : {}),
          metadata: { bbThreadId: request.params.threadId },
          permissionMode: knobs.permissionMode,
          ...(knobs.instructions !== null ? { instructions: knobs.instructions } : {}),
          environment: knobs.env,
        });
        const session = registerSession(request.params.threadId, handle, request.params.cwd);
        session.catalog = catalog;
        startPump(session, oc);
        await applyKnobs(session, knobs);
        warnDroppedTools(session, request.params.dynamicTools);
        announce(request.id, request.params.threadId, handle.id);
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
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
        await assertOwned(handle, request.params.threadId, request.params.cwd);
        const session = registerSession(request.params.threadId, handle, request.params.cwd);
        session.catalog = catalog;
        startPump(session, oc);
        await applyKnobs(session, knobs);
        warnDroppedTools(session, request.params.dynamicTools);
        announce(request.id, request.params.threadId, handle.id);
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
        const handle = await source.fork(request.params.sourceProviderCheckpointId);
        const session = registerSession(request.params.threadId, handle, request.params.cwd);
        session.catalog = catalog;
        startPump(session, oc);
        await applyKnobs(session, knobs);
        announce(request.id, request.params.threadId, handle.id);
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
        const knobs = knobsFromExecution({
          threadId: request.params.threadId,
          options: request.params.options,
          instructionMode: "append",
          catalog: session.catalog,
        });
        await assertRequestedAgent(session.cwd, knobs.agent);
        await applyKnobs(session, knobs);
        const delivery =
          request.method === "turn/steer" ? "steer" : session.busy ? "queue" : "steer";
        const turn = classifyOpenCodeTurn({
          input: request.params.input,
          clientRequestId: request.params.clientRequestId,
          delivery,
        });
        if (turn.kind === "prompt") {
          await assertRequestedSkills(session.cwd, turn.prompt.skills ?? []);
        }
        try {
          if (turn.kind === "compact") {
            await session.handle.compact();
          } else if (turn.kind === "command") {
            await session.handle.command({ name: turn.name, text: turn.text });
          } else {
            await session.handle.prompt(turn.prompt);
          }
        } catch (error) {
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
            error instanceof Error ? error.message : "OpenCode turn dispatch failed",
          );
          break;
        }
        acceptDispatch(
          session,
          request.params.clientRequestId,
          turn.kind === "compact",
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
        if (request.params.intent === "interrupt") {
          await session.handle.interrupt();
          await session.work.catch(() => undefined);
          sendDeltas(request.params.threadId, [{ kind: "session.ended" }]);
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
    void sendReply()
      .then(() => {
        if (pendingInteractions.get(id) === pending) {
          pendingInteractions.delete(id);
        }
      })
      .catch((error: unknown) => {
        sendDeltas(pending.threadId, [
          {
            kind: "provider.error",
            message:
              error instanceof Error
                ? error.message
                : "OpenCode interaction reply failed",
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
    if (pending === undefined) return;
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
    runBridgeRequest({ request: decoded.request, handleRequest, sendError });
  }

  const handleLine = createBridgeLineHandler({ handleParsedMessage });

  async function closeAll(): Promise<void> {
    closed = true;
    const live = [...sessions.values()];
    await Promise.all(live.map((session) => detachSession(session)));
    pendingInteractions.clear();
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
      mkdirSync(context.dataDir, { recursive: true });
      loadOwners();
    },
    onClose() {
      void closeAll();
    },
  });

  return {
    handleLine,
    experimental_providerBridge,
    closeAll,
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
