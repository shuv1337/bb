import { z } from "zod";
import {
  ZERO_TOKEN_USAGE,
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_presentationTitle as presentationTitle,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  experimental_withTitle as withTitle,
  type DeltaItemShape,
  type DeltaPresentation,
  type JsonValue,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { PendingInteractionPayload } from "@get-bb/plugin-sdk/provider-bridge";
import {
  openCodeFormPage,
  openCodeFormQuestionPayload,
  parseOpenCodeFormFields,
  type OpenCodeFormField,
} from "./forms.js";
import {
  OPENCODE_AGENT_EXTENSION_KIND,
  OPENCODE_MODEL_EXTENSION_KIND,
} from "./extension-kinds.js";
import type { OpenCodeNativeEvent, OpenCodeSessionMessage } from "./runtime/index.js";

const AGENT_MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Writing", completed: "Wrote" },
  icon: { glyph: "Text" },
};

const DELEGATION_PRESENTATION: DeltaPresentation = {
  label: { pending: "Delegating", completed: "Delegated" },
  icon: { glyph: "Bot" },
};

export const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "server.connected",
  "provider.updated",
  "model.updated",
  "integration.updated",
  "mcp.status.changed",
  "mcp.resources.changed",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "websearch.updated",
  "reference.updated",
  "plugin.updated",
  "session.instructions.updated",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "permission.replied",
  "form.replied",
  "session.step.streamed",
  "session.step.ended",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.step.failed",
  "session.permissions",
  "session.agent.selected",
  "session.model.selected",
]);

const COMMAND_EXIT_TRAILER = /Command exited with code (-?\d+)\.?\s*$/;

function commandExitCode(resultText: string, metadata: unknown): number {
  if (metadata !== null && typeof metadata === "object") {
    const record = metadata as Record<string, unknown>;
    for (const key of ["exitCode", "exit"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    }
  }
  const trailer = COMMAND_EXIT_TRAILER.exec(resultText);
  return trailer === null ? 0 : Number(trailer[1]);
}

const nativeEventSchema = z
  .object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    durable: z
      .object({
        aggregateID: z.string().optional(),
        seq: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function stripThoughtSignature(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripThoughtSignature);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "thoughtSignature")
        .map(([key, entry]) => [key, stripThoughtSignature(entry)]),
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function commandPresentation(command: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
    },
    presentationTitle(command),
  );
}

function fileChangePresentation(filePath: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Editing file", completed: "Edited file" },
      icon: { glyph: "FilePen" },
    },
    presentationTitle(filePath.split("/").filter(Boolean).at(-1) ?? filePath),
  );
}

function delegationPresentation(label: string): DeltaPresentation {
  return withTitle(DELEGATION_PRESENTATION, presentationTitle(label));
}

interface ToolState {
  name: string;
  input: unknown;
  opened: boolean;
}

interface ChildState {
  label: string;
  opened: boolean;
  turnOpened: boolean;
}

interface NativeSessionState {
  sessionID: string;
  cwd: string;
  turnSerial: number;
  turnOpen: boolean;
  executionTurnId: string | undefined;
  lastCheckpointId: string | undefined;
  lastSeq: number | undefined;
  usageTotal: ThreadEventTokenUsageBreakdown;
  agent: string | undefined;
  modelKey: string | undefined;
  tools: Map<string, ToolState>;
  children: Map<string, ChildState>;
  textOpen: Set<string>;
  compactionOpen: boolean;
}

function emptyNativeState(sessionID: string): NativeSessionState {
  return {
    sessionID,
    cwd: "",
    turnSerial: 0,
    turnOpen: false,
    executionTurnId: undefined,
    lastCheckpointId: undefined,
    lastSeq: undefined,
    usageTotal: { ...ZERO_TOKEN_USAGE },
    agent: undefined,
    modelKey: undefined,
    tools: new Map(),
    children: new Map(),
    textOpen: new Set(),
    compactionOpen: false,
  };
}

export interface OpenCodeTranslateContext {
  threadId: string;
  ownedSessionID: string;
  eventSessionID: string;
  parentID?: string;
  cwd: string;
  modelContextWindow: number | null;
  persistApprovals: boolean;
}

export type OpenCodeInteraction =
  | {
      kind: "permission";
      requestID: string;
      sessionID: string;
      payload: PendingInteractionPayload;
    }
  | {
      kind: "form";
      requestID: string;
      sessionID: string;
      fields: OpenCodeFormField[];
      payload: PendingInteractionPayload;
    };

export interface OpenCodeTranslateResult {
  deltas: ThreadDelta[];
  interactions: OpenCodeInteraction[];
  gap: boolean;
}

function keyFor(
  providerItemId: string,
  parentRef: string | undefined,
): { providerItemId: string; parentRef?: string } {
  return parentRef === undefined
    ? { providerItemId }
    : { providerItemId, parentRef };
}

function classifyTool(
  name: string,
  input: unknown,
  cwd: string,
): { item: DeltaItemShape; presentation: DeltaPresentation } {
  const record = asRecord(input);
  const inputPath =
    asString(record?.path) ?? asString(record?.file) ?? asString(record?.target);
  const query =
    asString(record?.pattern) ??
    asString(record?.query) ??
    asString(record?.glob) ??
    asString(record?.search);
  const command =
    asString(record?.command) ??
    asString(record?.cmd) ??
    (typeof record?.bash === "string" ? record.bash : undefined);
  const url = asString(record?.url);
  const lower = name.toLowerCase();
  if (lower === "read" || lower === "readfile" || lower === "view") {
    const filePath = inputPath ?? "";
    return {
      item: { type: "fileRead", path: filePath },
      presentation: fileReadPresentation(filePath),
    };
  }
  if (lower === "glob" || lower === "grep" || lower === "search") {
    const mode = lower === "glob" ? "path" : "content";
    const q = query ?? inputPath ?? "";
    return {
      item: {
        type: "search",
        mode,
        query: q,
        ...(inputPath !== undefined ? { path: inputPath } : {}),
      },
      presentation: searchPresentation({ mode, query: q }),
    };
  }
  if (lower === "bash" || lower === "shell" || lower === "cmd") {
    const cmd = command ?? name;
    return {
      item: { type: "command", command: cmd, cwd },
      presentation: commandPresentation(cmd),
    };
  }
  if (lower === "edit" || lower === "write" || lower === "applypatch") {
    const filePath = inputPath ?? name;
    return {
      item: {
        type: "fileChange",
        changes: [{ path: filePath, kind: lower === "write" ? "add" : "update" }],
      },
      presentation: fileChangePresentation(filePath),
    };
  }
  if (lower === "webfetch" || lower === "fetch") {
    const href = url ?? "";
    return {
      item: { type: "webFetch", url: href, pattern: null },
      presentation: webFetchPresentation(href),
    };
  }
  if (lower === "websearch") {
    const q = query ?? "";
    return {
      item: { type: "webSearch", queries: q.length > 0 ? [q] : [name] },
      presentation: webSearchPresentation(q.length > 0 ? q : undefined),
    };
  }
  return {
    item: { type: "tool", tool: name, args: stripThoughtSignature(input) },
    presentation: toolPresentation(name),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => asString(asRecord(part)?.text) ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
  }
  const record = asRecord(content);
  return asString(record?.text) ?? asString(record?.message) ?? "";
}

function parseTokens(value: unknown): ThreadEventTokenUsageBreakdown | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const input = asNumber(record.input) ?? 0;
  const output = asNumber(record.output) ?? 0;
  const reasoning = asNumber(record.reasoning) ?? 0;
  const cache = asRecord(record.cache);
  const cacheRead = asNumber(cache?.read) ?? 0;
  const cacheWrite = asNumber(cache?.write) ?? 0;
  return {
    totalTokens: input + output + cacheRead + cacheWrite,
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

function subtractUsage(
  total: ThreadEventTokenUsageBreakdown,
  previous: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, total.totalTokens - previous.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - previous.cachedInputTokens),
    cacheReadInputTokens: Math.max(
      0,
      (total.cacheReadInputTokens ?? 0) - (previous.cacheReadInputTokens ?? 0),
    ),
    cacheWriteInputTokens: Math.max(
      0,
      (total.cacheWriteInputTokens ?? 0) - (previous.cacheWriteInputTokens ?? 0),
    ),
    outputTokens: Math.max(0, total.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      total.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
  };
}

function modelKey(data: Record<string, unknown>): string | undefined {
  const model = asRecord(data.model);
  if (model === null) {
    return undefined;
  }
  const providerID = asString(model.providerID);
  const id = asString(model.id);
  if (providerID === undefined || id === undefined) {
    return undefined;
  }
  return `${providerID}/${id}`;
}

function approvalPayload(args: {
  requestID: string;
  action: string;
  resources: string[];
  toolId: string | undefined;
  persistApprovals: boolean;
}): PendingInteractionPayload {
  const resource = args.resources[0] ?? args.action;
  const itemId = args.toolId ?? args.requestID;
  const availableDecisions: ("allow_once" | "allow_for_session" | "deny")[] =
    args.persistApprovals
      ? ["allow_once", "allow_for_session", "deny"]
      : ["allow_once", "deny"];
  if (args.action === "edit" || args.action === "write") {
    return {
      kind: "approval",
      subject: {
        kind: "file_change",
        itemId,
        writeScope: resource,
        sessionGrant: null,
      },
      reason: `OpenCode asked to ${args.action} ${resource}`,
      availableDecisions,
    };
  }
  if (args.action === "shell" || args.action === "bash") {
    return {
      kind: "approval",
      subject: {
        kind: "command",
        itemId,
        command: resource,
        cwd: null,
        actions: [{ type: "unknown", command: resource }],
        sessionGrant: null,
      },
      reason: `OpenCode asked to run ${resource}`,
      availableDecisions,
    };
  }
  if (args.action === "read") {
    return {
      kind: "approval",
      subject: {
        kind: "tool_use",
        itemId,
        tool: args.action,
        presentation: fileReadPresentation(resource),
      },
      reason: `OpenCode asked to read ${resource}`,
      availableDecisions,
    };
  }
  return {
    kind: "approval",
    subject: {
      kind: "tool_use",
      itemId,
      tool: args.action,
      presentation: toolPresentation(args.action),
    },
    reason: `OpenCode asked for ${args.action}`,
    availableDecisions,
  };
}

function ensureTurnOpen(
  state: NativeSessionState,
  parentRef: string | undefined,
): ThreadDelta[] {
  if (state.turnOpen) {
    return [];
  }
  state.turnOpen = true;
  if (state.executionTurnId === undefined) {
    state.turnSerial += 1;
    state.executionTurnId = `turn:${state.sessionID}:${state.turnSerial}`;
  }
  return [
    {
      kind: "turn.open",
      ...(state.executionTurnId !== undefined
        ? { providerTurnId: state.executionTurnId }
        : {}),
      ...(parentRef !== undefined ? { parentRef } : {}),
    },
  ];
}

function closeTurn(
  state: NativeSessionState,
  status: "completed" | "interrupted" | "failed",
  errorMessage?: string,
): ThreadDelta[] {
  if (!state.turnOpen) {
    state.executionTurnId = undefined;
    return [];
  }
  state.turnOpen = false;
  const providerTurnId = state.executionTurnId;
  state.executionTurnId = undefined;
  return [
    {
      kind: "turn.boundary",
      status,
      ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
      ...(state.lastCheckpointId !== undefined
        ? { providerCheckpointId: state.lastCheckpointId }
        : {}),
      ...(providerTurnId !== undefined ? { providerTurnId } : {}),
    },
  ];
}

function closeDelegation(
  state: NativeSessionState,
  childId: string,
  status: "completed" | "interrupted" | "failed",
): ThreadDelta[] {
  const child = state.children.get(childId);
  const label = child?.label ?? childId;
  const presentation = delegationPresentation(label);
  const deltas: ThreadDelta[] = [];
  if (child?.turnOpened) {
    deltas.push({
      kind: "turn.boundary",
      status,
      providerTurnId: childId,
    });
  }
  if (child?.opened) {
    deltas.push({
      kind: "item.close",
      key: { providerItemId: childId },
      status,
      item: {
        type: "delegation",
        childRef: childId,
        label,
        background: false,
      },
      presentation,
    });
  }
  state.children.delete(childId);
  return deltas;
}

function closeOpenItems(
  state: NativeSessionState,
  parentRef: string | undefined,
  status: "interrupted" | "failed",
  providerTurnId: string | undefined,
): ThreadDelta[] {
  const turnScope = providerTurnId !== undefined ? { providerTurnId } : {};
  const deltas: ThreadDelta[] = [];
  for (const [id, tool] of state.tools) {
    if (!tool.opened) continue;
    const classified = classifyTool(tool.name, tool.input, state.cwd);
    deltas.push({
      kind: "item.close",
      key: keyFor(id, parentRef),
      status,
      item: classified.item,
      presentation: classified.presentation,
      ...turnScope,
    });
  }
  state.tools.clear();
  for (const textId of state.textOpen) {
    deltas.push({
      kind: "item.textClose",
      key: keyFor(textId, parentRef),
      channel: "agentMessage",
      ...turnScope,
    });
  }
  state.textOpen.clear();
  if (state.compactionOpen) {
    deltas.push({
      kind: "item.close",
      key: keyFor("compaction", parentRef),
      status,
      item: { type: "compaction" },
      presentation: COMPACTION_PRESENTATION,
      ...turnScope,
    });
    state.compactionOpen = false;
  }
  return deltas;
}

interface OpenCodeTurnFailure {
  message: string;
  type: string | undefined;
  status: number | undefined;
}

function turnFailureFrom(data: Record<string, unknown>): OpenCodeTurnFailure {
  const error = asRecord(data.error);
  return {
    message: asString(error?.message) ?? "OpenCode turn failed",
    type: asString(error?.type),
    status: asNumber(error?.status),
  };
}

function failureDelta(
  failure: OpenCodeTurnFailure,
  providerTurnId: string | undefined,
): ThreadDelta {
  return {
    kind: "provider.error",
    message: failure.message,
    ...(failure.type !== undefined ? { detail: failure.type } : {}),
    ...(failure.status === 401
      ? {
          errorInfo: {
            category: "unauthorized" as const,
            providerCode: failure.type ?? null,
            httpStatusCode: 401,
          },
        }
      : {}),
    ...(providerTurnId !== undefined ? { providerTurnId } : { threadScoped: true }),
  };
}

export function createOpenCodeDeltaTranslator() {
  const natives = new Map<string, NativeSessionState>();

  function nativeState(sessionID: string): NativeSessionState {
    const existing = natives.get(sessionID);
    if (existing !== undefined) {
      return existing;
    }
    const created = emptyNativeState(sessionID);
    natives.set(sessionID, created);
    return created;
  }

  function reset(sessionID: string): void {
    natives.set(sessionID, emptyNativeState(sessionID));
  }

  function forget(sessionID: string): void {
    natives.delete(sessionID);
  }

  function settleOwnedTurn(
    owner: NativeSessionState,
    status: "interrupted" | "failed",
    failure?: OpenCodeTurnFailure,
  ): ThreadDelta[] {
    const providerTurnId = owner.turnOpen ? owner.executionTurnId : undefined;
    const deltas: ThreadDelta[] = [];
    for (const childId of [...owner.children.keys()]) {
      const child = natives.get(childId);
      if (child !== undefined) {
        deltas.push(...closeOpenItems(child, childId, status, childId));
      }
      deltas.push(...closeDelegation(owner, childId, status));
    }
    deltas.push(...closeOpenItems(owner, undefined, status, providerTurnId));
    if (failure !== undefined) {
      deltas.push(failureDelta(failure, providerTurnId));
    }
    deltas.push(...closeTurn(owner, status, failure?.message));
    return deltas;
  }

  function settleTurn(
    sessionID: string,
    status: "interrupted" | "failed",
  ): ThreadDelta[] {
    const state = natives.get(sessionID);
    if (state === undefined) return [];
    return settleOwnedTurn(state, status);
  }

  function checkpoint(sessionID: string): string | undefined {
    return natives.get(sessionID)?.lastCheckpointId;
  }

  function executionTurnId(sessionID: string): string | undefined {
    return natives.get(sessionID)?.executionTurnId;
  }

  function reconcileAfterResync(
    sessionID: string,
    messages: readonly OpenCodeSessionMessage[],
  ): ThreadDelta[] {
    const state = nativeState(sessionID);
    const deltas: ThreadDelta[] = [];
    for (const [id, tool] of state.tools) {
      if (!tool.opened) {
        continue;
      }
      const classified = classifyTool(tool.name, tool.input, "");
      deltas.push({
        kind: "item.close",
        key: { providerItemId: id },
        status: "completed",
        item: classified.item,
        presentation: classified.presentation,
      });
    }
    state.tools.clear();
    for (const textId of state.textOpen) {
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: textId },
        channel: "agentMessage",
      });
    }
    state.textOpen.clear();
    if (state.compactionOpen) {
      deltas.push({
        kind: "item.close",
        key: { providerItemId: "compaction" },
        status: "completed",
        item: { type: "compaction" },
        presentation: COMPACTION_PRESENTATION,
      });
      state.compactionOpen = false;
    }
    const last = messages[messages.length - 1];
    if (last !== undefined) {
      state.lastCheckpointId = last.id;
    }
    if (state.turnOpen) {
      deltas.push(...closeTurn(state, "completed"));
    }
    return deltas;
  }

  function translate(
    raw: OpenCodeNativeEvent,
    ctx: OpenCodeTranslateContext,
  ): OpenCodeTranslateResult {
    const parsed = nativeEventSchema.safeParse(raw);
    if (!parsed.success) {
      return { deltas: [], interactions: [], gap: false };
    }
    const event = parsed.data;
    const data = event.data ?? {};
    const eventSessionID = ctx.eventSessionID;
    const isChild = eventSessionID !== ctx.ownedSessionID;
    const parentRef = isChild ? eventSessionID : undefined;
    const owner = nativeState(ctx.ownedSessionID);
    const native = nativeState(eventSessionID);
    owner.cwd = ctx.cwd;
    native.cwd = ctx.cwd;
    const aggregateID = event.durable?.aggregateID ?? eventSessionID;
    const seq = event.durable?.seq;
    let gap = false;
    if (seq !== undefined) {
      const seqState = nativeState(aggregateID);
      if (seqState.lastSeq !== undefined && seq > seqState.lastSeq + 1) {
        gap = true;
      }
      seqState.lastSeq = seq;
    }
    if (IGNORED_EVENT_TYPES.has(event.type)) {
      return { deltas: [], interactions: [], gap };
    }
    const deltas: ThreadDelta[] = [];
    const interactions: OpenCodeInteraction[] = [];
    const turnId = () =>
      isChild ? eventSessionID : native.executionTurnId;

    switch (event.type) {
      case "session.created": {
        if (!isChild && ctx.parentID === undefined) {
          break;
        }
        const label =
          asString(data.title) ?? asString(data.agent) ?? eventSessionID;
        owner.children.set(eventSessionID, {
          label,
          opened: true,
          turnOpened: false,
        });
        const presentation = delegationPresentation(label);
        deltas.push(...ensureTurnOpen(owner, undefined), {
          kind: "item.open",
          key: { providerItemId: eventSessionID },
          item: {
            type: "delegation",
            childRef: eventSessionID,
            label,
            background: false,
          },
          presentation,
        });
        break;
      }
      case "session.execution.started": {
        if (isChild) {
          const child = owner.children.get(eventSessionID);
          if (child !== undefined && !child.turnOpened) {
            deltas.push({
              kind: "turn.open",
              providerTurnId: eventSessionID,
              parentRef: eventSessionID,
            });
            child.turnOpened = true;
          }
          break;
        }
        if (!native.turnOpen) {
          native.executionTurnId = `exec:${eventSessionID}:${seq ?? 0}`;
        }
        deltas.push(...ensureTurnOpen(native, undefined));
        break;
      }
      case "session.execution.succeeded": {
        if (isChild) {
          deltas.push(...closeDelegation(owner, eventSessionID, "completed"));
          break;
        }
        deltas.push(...closeTurn(native, "completed"));
        break;
      }
      case "session.execution.failed": {
        if (isChild) {
          deltas.push(...closeDelegation(owner, eventSessionID, "failed"));
          break;
        }
        deltas.push(...settleOwnedTurn(native, "failed", turnFailureFrom(data)));
        break;
      }
      case "session.execution.interrupted": {
        if (isChild) {
          deltas.push(...closeDelegation(owner, eventSessionID, "interrupted"));
          break;
        }
        deltas.push(...settleOwnedTurn(native, "interrupted"));
        break;
      }
      case "session.step.started": {
        const assistantMessageID = asString(data.assistantMessageID);
        if (assistantMessageID !== undefined) {
          native.lastCheckpointId = assistantMessageID;
        }
        const agent = asString(data.agent);
        const nextModel = modelKey(data);
        if (!isChild && agent !== undefined && agent !== owner.agent) {
          owner.agent = agent;
          deltas.push({
            kind: "extension.state",
            extensionKind: OPENCODE_AGENT_EXTENSION_KIND,
            payload: { agent },
          });
        }
        if (!isChild && nextModel !== undefined && nextModel !== owner.modelKey) {
          owner.modelKey = nextModel;
          deltas.push({
            kind: "extension.state",
            extensionKind: OPENCODE_MODEL_EXTENSION_KIND,
            payload: { model: nextModel },
          });
        }
        if (!isChild) {
          deltas.push(...ensureTurnOpen(native, undefined));
        }
        break;
      }
      case "session.tool.input.started": {
        const id = asString(data.id);
        const name = asString(data.name) ?? "tool";
        if (id === undefined) {
          break;
        }
        if (native.tools.get(id)?.opened) {
          break;
        }
        const classified = classifyTool(name, {}, ctx.cwd);
        native.tools.set(id, { name, input: {}, opened: true });
        deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
          kind: "item.open",
          key: keyFor(id, parentRef),
          item: classified.item,
          presentation: classified.presentation,
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        break;
      }
      case "session.tool.called": {
        const id = asString(data.id);
        const input = stripThoughtSignature(data.input);
        if (id === undefined) {
          break;
        }
        const name = native.tools.get(id)?.name ?? "tool";
        const classified = classifyTool(name, input, ctx.cwd);
        const existing = native.tools.get(id);
        native.tools.set(id, { name, input, opened: true });
        if (existing?.opened !== true) {
          deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
            kind: "item.open",
            key: keyFor(id, parentRef),
            item: classified.item,
            presentation: classified.presentation,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          });
        }
        break;
      }
      case "session.tool.success": {
        const id = asString(data.id);
        if (id === undefined) {
          break;
        }
        const tool = native.tools.get(id);
        const name = tool?.name ?? "tool";
        const classified = classifyTool(name, tool?.input, ctx.cwd);
        const resultText = toolResultText(data.content);
        if (tool?.opened !== true) {
          deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
            kind: "item.open",
            key: keyFor(id, parentRef),
            item: classified.item,
            presentation: classified.presentation,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          });
        }
        if (classified.item.type === "command" && resultText.length > 0) {
          deltas.push({
            kind: "item.outputDelta",
            key: keyFor(id, parentRef),
            channel: "command",
            text: resultText,
          });
        }
        const exitCode = commandExitCode(resultText, data.metadata);
        const closedItem =
          classified.item.type === "command"
            ? {
                ...classified.item,
                aggregatedOutput: resultText,
                exitCode,
              }
            : classified.item.type === "tool"
              ? {
                  ...classified.item,
                  result: stripThoughtSignature(data.content),
                }
              : classified.item;
        deltas.push({
          kind: "item.close",
          key: keyFor(id, parentRef),
          status: "completed",
          ...(classified.item.type === "command"
            ? { aggregatedOutput: resultText, exitCode }
            : {}),
          ...(resultText.length > 0 ? { resultText } : {}),
          item: closedItem,
          presentation: classified.presentation,
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        native.tools.delete(id);
        break;
      }
      case "permission.asked": {
        const requestID = asString(data.id);
        if (requestID === undefined) {
          break;
        }
        const action = asString(data.action) ?? "tool";
        const resources = Array.isArray(data.resources)
          ? data.resources.filter((entry): entry is string => typeof entry === "string")
          : [];
        const source = asRecord(data.source);
        interactions.push({
          kind: "permission",
          requestID,
          sessionID: eventSessionID,
          payload: approvalPayload({
            requestID,
            action,
            resources,
            toolId: asString(source?.id),
            persistApprovals: ctx.persistApprovals,
          }),
        });
        break;
      }
      case "session.text.started": {
        const assistantMessageID = asString(data.assistantMessageID);
        if (assistantMessageID === undefined) {
          break;
        }
        const ordinal = asNumber(data.ordinal) ?? 0;
        const itemId = `text:${assistantMessageID}:${ordinal}`;
        native.textOpen.add(itemId);
        native.lastCheckpointId = assistantMessageID;
        deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
          kind: "item.open",
          key: keyFor(itemId, parentRef),
          item: { type: "agentMessage", text: "" },
          presentation: AGENT_MESSAGE_PRESENTATION,
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        break;
      }
      case "session.text.delta": {
        const assistantMessageID = asString(data.assistantMessageID);
        const deltaText = typeof data.delta === "string" ? data.delta : "";
        if (assistantMessageID === undefined || deltaText.length === 0) {
          break;
        }
        const ordinal = asNumber(data.ordinal) ?? 0;
        const itemId = `text:${assistantMessageID}:${ordinal}`;
        if (!native.textOpen.has(itemId)) {
          native.textOpen.add(itemId);
          deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
            kind: "item.open",
            key: keyFor(itemId, parentRef),
            item: { type: "agentMessage", text: "" },
            presentation: AGENT_MESSAGE_PRESENTATION,
          });
        }
        deltas.push({
          kind: "item.textDelta",
          key: keyFor(itemId, parentRef),
          channel: "agentMessage",
          text: deltaText,
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        break;
      }
      case "session.text.ended": {
        const assistantMessageID = asString(data.assistantMessageID);
        if (assistantMessageID === undefined) {
          break;
        }
        const ordinal = asNumber(data.ordinal) ?? 0;
        const itemId = `text:${assistantMessageID}:${ordinal}`;
        const text = typeof data.text === "string" ? data.text : undefined;
        native.lastCheckpointId = assistantMessageID;
        if (!native.textOpen.has(itemId)) {
          deltas.push({
            kind: "item.open",
            key: keyFor(itemId, parentRef),
            item: { type: "agentMessage", text: text ?? "" },
            presentation: AGENT_MESSAGE_PRESENTATION,
          });
        }
        deltas.push({
          kind: "item.textClose",
          key: keyFor(itemId, parentRef),
          channel: "agentMessage",
          ...(text !== undefined ? { text } : {}),
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        native.textOpen.delete(itemId);
        break;
      }
      case "session.usage.updated": {
        const total = parseTokens(data.tokens);
        if (total === null) {
          break;
        }
        const last = subtractUsage(total, native.usageTotal);
        native.usageTotal = total;
        deltas.push(
          {
            kind: "usage",
            total,
            last,
            modelContextWindow: ctx.modelContextWindow,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          },
          {
            kind: "contextWindow",
            used: total.totalTokens,
            size: ctx.modelContextWindow,
            estimated: ctx.modelContextWindow === null,
            attach: "currentOrLast",
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          },
        );
        break;
      }
      case "form.created": {
        const form = asRecord(data.form) ?? data;
        const formID = asString(form.id);
        const fields = parseOpenCodeFormFields(form.fields);
        if (formID === undefined || fields === null) {
          break;
        }
        interactions.push({
          kind: "form",
          requestID: formID,
          sessionID: eventSessionID,
          fields,
          payload: openCodeFormQuestionPayload(openCodeFormPage(fields, 0)),
        });
        break;
      }
      case "session.compaction.started": {
        native.compactionOpen = true;
        deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
          kind: "item.open",
          key: keyFor("compaction", parentRef),
          item: { type: "compaction" },
          presentation: COMPACTION_PRESENTATION,
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        break;
      }
      case "session.compaction.delta": {
        if (!native.compactionOpen) {
          native.compactionOpen = true;
          deltas.push(...ensureTurnOpen(isChild ? owner : native, parentRef), {
            kind: "item.open",
            key: keyFor("compaction", parentRef),
            item: { type: "compaction" },
            presentation: COMPACTION_PRESENTATION,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          });
        }
        break;
      }
      case "session.compaction.ended": {
        if (native.compactionOpen) {
          deltas.push({
            kind: "item.close",
            key: keyFor("compaction", parentRef),
            status: "completed",
            item: { type: "compaction" },
            presentation: COMPACTION_PRESENTATION,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          });
          native.compactionOpen = false;
        }
        deltas.push({
          kind: "context.compacted",
          ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
        });
        const tokens = parseTokens(data.tokens);
        if (tokens !== null) {
          const last = subtractUsage(tokens, native.usageTotal);
          native.usageTotal = tokens;
          deltas.push({
            kind: "usage",
            total: tokens,
            last,
            modelContextWindow: ctx.modelContextWindow,
            ...(turnId() !== undefined ? { providerTurnId: turnId() } : {}),
          });
        }
        break;
      }
      default: {
        deltas.push({
          kind: "unhandled",
          raw: {
            jsonrpc: "2.0",
            method: event.type,
            params: stripThoughtSignature(data) as JsonValue,
          },
          rawType: event.type,
          vouchedTurn: native.turnOpen,
          ...(parentRef !== undefined ? { parentRef } : {}),
        });
      }
    }

    return { deltas, interactions, gap };
  }

  return {
    translate,
    reset,
    forget,
    checkpoint,
    executionTurnId,
    reconcileAfterResync,
    settleTurn,
  };
}

export type OpenCodeDeltaTranslator = ReturnType<typeof createOpenCodeDeltaTranslator>;
