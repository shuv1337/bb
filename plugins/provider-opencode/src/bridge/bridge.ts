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
  type InteractionRequestPayload,
  type PendingInteractionResolution,
  type ProviderBridgeContext,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { toAvailableModels } from "../models.js";
import { createOpenCodeDeltaTranslator } from "../delta-translation.js";
import {
  classifyOpenCodeTurn,
  knobsFromExecution,
  mapApprovalToOpenCodeReply,
  sessionTitleForThread,
  type AppliedSessionKnobs,
} from "../session-params.js";
import {
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

function isExtensionResolution(
  resolution: PendingInteractionResolution,
): resolution is { kind: "request_answer"; value: unknown } {
  return "kind" in resolution && resolution.kind === "request_answer";
}

function formAnswerFromResolution(
  resolution: PendingInteractionResolution,
): Record<string, string | number | boolean | string[]> {
  if (isUserQuestionPendingInteractionResolution(resolution)) {
    const answer: Record<string, string | number | boolean | string[]> = {};
    for (const [key, entry] of Object.entries(resolution.answers)) {
      if (entry.freeText !== undefined && entry.selected.length === 0) {
        answer[key] = entry.freeText;
      } else if (entry.selected.length === 1 && entry.freeText === undefined) {
        answer[key] = entry.selected[0] ?? "";
      } else if (entry.selected.length > 1) {
        answer[key] = [...entry.selected];
      } else if (entry.freeText !== undefined) {
        answer[key] = entry.freeText;
      }
    }
    return answer;
  }
  if (
    isExtensionResolution(resolution) &&
    resolution.value !== null &&
    typeof resolution.value === "object" &&
    !Array.isArray(resolution.value)
  ) {
    return resolution.value as Record<string, string | number | boolean | string[]>;
  }
  throw new Error("OpenCode form answer does not match the requested fields");
}

interface PendingInteraction {
  kind: "permission" | "form";
  requestID: string;
  persistApprovals: boolean;
  handle: SessionHandle;
}

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
  let closed = false;

  function sendDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    send({
      jsonrpc: "2.0",
      method: THREAD_DELTA_NOTIFICATION_METHOD,
      params: { threadId, deltas },
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
    sessionID: string;
    kind: "permission" | "form";
    requestID: string;
    payload: InteractionRequestPayload;
  }): void {
    interactionSerial += 1;
    const id = `oc-int-${interactionSerial}`;
    pendingInteractions.set(id, {
      kind: args.kind,
      requestID: args.requestID,
      persistApprovals: args.session.persistApprovals,
      handle: handleForEvent(args.session, args.sessionID),
    });
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
      sendInteraction({
        session,
        sessionID: interaction.sessionID,
        kind: interaction.payload.kind === "approval" ? "permission" : "form",
        requestID: interaction.requestID,
        payload: interaction.payload,
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
            await enqueue(session, () => applyRuntimeEvent(session, event));
            if (session.closed) {
              return;
            }
          }
        } catch {
          if (session.closed) {
            return;
          }
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
    session.abort.abort();
    sessions.delete(session.threadId);
    sessionsByProviderId.delete(session.handle.id);
    await session.work.catch(() => undefined);
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
          const liveTurn = translator.executionTurnId(session.handle.id);
          if (!session.busy || liveTurn !== request.params.expectedTurnId) {
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
        await applyKnobs(session, knobs);
        const delivery =
          request.method === "turn/steer" ? "steer" : session.busy ? "queue" : "steer";
        const turn = classifyOpenCodeTurn({
          input: request.params.input,
          clientRequestId: request.params.clientRequestId,
          delivery,
        });
        sendDeltas(request.params.threadId, [
          { kind: "input.accepted", clientRequestId: request.params.clientRequestId },
        ]);
        if (turn.kind === "compact") {
          await session.handle.compact();
          sendResult(request.id, { threadId: request.params.threadId });
          break;
        }
        if (turn.kind === "command") {
          await session.handle.command({ name: turn.name, text: turn.text });
          sendResult(request.id, { threadId: request.params.threadId });
          break;
        }
        await session.handle.prompt(turn.prompt);
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

  function handleParsedMessage(parsed: unknown): void {
    const response = decodeBridgeJsonRpcResponse(parsed);
    if (response !== null) {
      const pending = pendingInteractions.get(String(response.id));
      if (pending !== undefined) {
        pendingInteractions.delete(String(response.id));
        if ("result" in response) {
          const resolution = pendingInteractionResolutionSchema.safeParse(response.result);
          if (resolution.success) {
            void (async () => {
              if (
                pending.kind === "permission" &&
                isApprovalPendingInteractionResolution(resolution.data)
              ) {
                await pending.handle.replyPermission(
                  pending.requestID,
                  mapApprovalToOpenCodeReply({
                    decision: resolution.data.decision,
                    persistApprovals: pending.persistApprovals,
                  }),
                );
                return;
              }
              if (pending.kind === "form") {
                await pending.handle.replyForm(
                  pending.requestID,
                  formAnswerFromResolution(resolution.data),
                );
              }
            })();
          }
        }
        return;
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
