import { sessionRulesForPermissionMode } from "../permissions.js";
import {
  extractConfigDefaultAgent,
  resolveDefaultAgentId,
} from "./agents.js";
import { EventPump } from "./events.js";
import {
  OpenCodeInstructionReplaceError,
  OpenCodeRuntimeNotReadyError,
  OpenCodeUnauthenticatedError,
} from "./errors.js";
import { openCodeBeforeForInclusiveCheckpoint } from "./fork.js";
import { BB_INSTRUCTION_ENTRY_KEY } from "./types.js";
import type {
  CreateSessionInput,
  OpenCodeAgent,
  OpenCodeAgentCatalog,
  OpenCodeCommand,
  OpenCodeCommandInput,
  OpenCodeDiscoveryHealth,
  OpenCodeLocation,
  OpenCodeModel,
  OpenCodeNativeEvent,
  OpenCodePermissionRule,
  OpenCodePromptInput,
  OpenCodeRuntime,
  OpenCodeSessionInfo,
  OpenCodeSessionMessage,
  OpenCodeSkill,
  RuntimeSessionEvent,
  SessionHandle,
} from "./types.js";

export type CreateFakeOpenCodeRuntimeOptions = {
  health?: OpenCodeDiscoveryHealth;
  models?: OpenCodeModel[];
  agents?: OpenCodeAgent[];
  configEntries?: unknown[];
  skills?: OpenCodeSkill[];
  commands?: OpenCodeCommand[];
  version?: string;
  url?: string;
  appId?: string | null;
  scriptTurns?: boolean;
  holdInterrupts?: boolean;
};

export interface FakeOpenCodeCallLog {
  prompts: OpenCodePromptInput[];
  commands: OpenCodeCommandInput[];
  permissionReplies: {
    requestID: string;
    reply: "once" | "always" | "reject";
  }[];
  formReplies: {
    formID: string;
    answer: Record<string, string | number | boolean | string[]>;
  }[];
  titles: string[];
  compacts: number;
  interrupts: number;
  interruptedSessions: string[];
  forks: number;
  moves: { sessionID: string; directory: string }[];
  promptDirectories: { sessionID: string; directory: string }[];
  permissions: { sessionID: string; rules: readonly OpenCodePermissionRule[] }[];
  instructions: { sessionID: string; text: string }[];
}

type FakeSession = {
  info: OpenCodeSessionInfo;
  messages: OpenCodeSessionMessage[];
  instructions: string | null;
  environment: Record<string, string>;
};

function readyHealth(): OpenCodeDiscoveryHealth {
  return {
    status: "ready",
    statusMessage: null,
    appId: "opencode",
    version: "2.0.10",
    installedVersion: "2.0.10",
    url: "http://127.0.0.1:9",
    registrationFile: null,
    pid: 1,
    pathBinaryAppId: "opencode",
  };
}

export interface FakeOpenCodeRuntime extends OpenCodeRuntime {
  emit(event: Record<string, unknown>): void;
  play(event: Record<string, unknown>): Promise<void>;
  failStream(error: unknown): void;
  readonly calls: FakeOpenCodeCallLog;
}

export function createFakeOpenCodeRuntime(
  options: CreateFakeOpenCodeRuntimeOptions = {},
): FakeOpenCodeRuntime {
  let healthSnapshot = options.health ?? readyHealth();
  let closed = false;
  let streamFailure: Error | null = null;
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}${seq.toString(16).padStart(4, "0")}`;
  };
  type QueuedEvent = { event: unknown; settle: () => void };
  const pushQueue: QueuedEvent[][] = [];
  const queuedBeforeConnect: QueuedEvent[] = [];
  const wakeWaiters: Array<() => void> = [];
  const calls: FakeOpenCodeCallLog = {
    prompts: [],
    commands: [],
    permissionReplies: [],
    formReplies: [],
    titles: [],
    compacts: 0,
    interrupts: 0,
    interruptedSessions: [],
    forks: 0,
    moves: [],
    promptDirectories: [],
    permissions: [],
    instructions: [],
  };
  let scriptSeq = 0;

  const wake = (): void => {
    const waiter = wakeWaiters.shift();
    waiter?.();
  };

  const waitForWake = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", finish);
        const index = wakeWaiters.indexOf(finish);
        if (index >= 0) wakeWaiters.splice(index, 1);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      wakeWaiters.push(finish);
    });

  const queueEvent = (event: unknown): Promise<void> => {
    let settle = (): void => {};
    const delivered = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const queued: QueuedEvent = { event, settle };
    if (pushQueue.length === 0) {
      queuedBeforeConnect.push(queued);
      return delivered;
    }
    for (const queue of pushQueue) queue.push(queued);
    wake();
    return delivered;
  };

  const pump = new EventPump(async function* (signal) {
    yield { type: "server.connected", data: {} };
    const local: QueuedEvent[] = [];
    while (queuedBeforeConnect.length > 0) {
      const pending = queuedBeforeConnect.shift();
      if (pending !== undefined) local.push(pending);
    }
    pushQueue.push(local);
    try {
      while (!signal.aborted) {
        const item = local.shift();
        if (item !== undefined) {
          yield item.event;
          item.settle();
          continue;
        }
        await waitForWake(signal);
      }
    } finally {
      const index = pushQueue.indexOf(local);
      if (index >= 0) pushQueue.splice(index, 1);
      while (local.length > 0) local.shift()?.settle();
    }
  });

  const durable = new Map<string, OpenCodeNativeEvent[]>();
  const rememberDurable = (event: Record<string, unknown>): void => {
    const data = event.data;
    const sessionID =
      data !== null && typeof data === "object" && !Array.isArray(data) && typeof (data as { sessionID?: unknown }).sessionID === "string"
        ? (data as { sessionID: string }).sessionID
        : undefined;
    if (sessionID === undefined) return;
    const list = durable.get(sessionID) ?? [];
    list.push(event as OpenCodeNativeEvent);
    durable.set(sessionID, list);
  };
  const emit = (event: Record<string, unknown>): void => {
    rememberDurable(event);
    void queueEvent(event);
  };

  const reportStreamFailure = (error: unknown): Error => {
    const classified =
      streamFailure ??
      (error instanceof OpenCodeUnauthenticatedError
        ? error
        : error instanceof Error
          ? error
          : new Error("OpenCode event stream failed"));
    if (streamFailure === null) {
      streamFailure = classified;
      healthSnapshot = {
        ...healthSnapshot,
        status:
          classified instanceof OpenCodeUnauthenticatedError
            ? "unauthenticated"
            : "unknown",
        statusMessage: classified.message,
      };
    }
    pump.fail(classified);
    return classified;
  };

  const assertReady = (): void => {
    if (
      healthSnapshot.status === "unauthenticated" ||
      healthSnapshot.status === "expired"
    ) {
      throw new OpenCodeUnauthenticatedError(
        healthSnapshot.statusMessage ?? "OpenCode rejected authentication",
      );
    }
    if (healthSnapshot.status !== "ready") {
      throw new OpenCodeRuntimeNotReadyError(
        healthSnapshot.statusMessage ?? "not ready",
      );
    }
  };

  const connect = async (): Promise<void> => {
    try {
      await pump.ensureRunning();
    } catch (error) {
      if (closed) throw error;
      throw reportStreamFailure(error);
    }
  };

  const handleOf = (session: FakeSession): SessionHandle => {
    const id = session.info.id;
    const location = session.info.location;
    const assertOpen = () => {
      if (closed) {
        throw new OpenCodeRuntimeNotReadyError("OpenCode runtime is closed");
      }
    };
    return {
      id,
      location,
      info: async () => {
        assertOpen();
        return session.info;
      },
      prompt: async (input: OpenCodePromptInput) => {
        assertOpen();
        calls.prompts.push(input);
        calls.promptDirectories.push({ sessionID: id, directory: location.directory });
        const messageId = nextId("msg_");
        session.messages.push({
          id: messageId,
          type: "user",
          text: input.text,
        });
        emit({
          type: "session.inbox.enqueued",
          data: { sessionID: id, inboxID: messageId },
        });
        if (options.scriptTurns !== true) return;
        scriptSeq += 1;
        const turnSeq = scriptSeq;
        if (input.text.includes("/hold")) {
          await queueEvent({
            type: "session.execution.started",
            data: { sessionID: id },
            durable: { seq: turnSeq },
          });
          return;
        }
        const assistantId = nextId("msg_");
        await queueEvent({
          type: "session.execution.started",
          data: { sessionID: id },
          durable: { seq: turnSeq },
        });
        await queueEvent({
          type: "session.text.started",
          data: { sessionID: id, assistantMessageID: assistantId, ordinal: 0 },
        });
        await queueEvent({
          type: "session.text.delta",
          data: {
            sessionID: id,
            assistantMessageID: assistantId,
            ordinal: 0,
            delta: `echo:${input.text}`,
          },
        });
        await queueEvent({
          type: "session.text.ended",
          data: {
            sessionID: id,
            assistantMessageID: assistantId,
            ordinal: 0,
            text: `echo:${input.text}`,
          },
        });
        await queueEvent({
          type: "session.execution.succeeded",
          data: { sessionID: id },
        });
      },
      command: async (input) => {
        assertOpen();
        calls.commands.push({ ...input });
        session.messages.push({
          id: nextId("msg_"),
          type: "user",
          text: `/${input.name} ${input.text}`.trim(),
        });
      },
      compact: async () => {
        assertOpen();
        calls.compacts += 1;
        await queueEvent({
          type: "session.execution.started",
          data: { sessionID: id },
        });
        await queueEvent({
          type: "session.compaction.started",
          data: { sessionID: id, reason: "manual" },
        });
      },
      interrupt: async () => {
        assertOpen();
        calls.interrupts += 1;
        calls.interruptedSessions.push(id);
        if (options.holdInterrupts === true) return;
        await queueEvent({
          type: "session.execution.interrupted",
          data: { sessionID: id },
        });
      },
      switchAgent: async (agent) => {
        assertOpen();
        session.info = { ...session.info, agent };
      },
      switchModel: async (model) => {
        assertOpen();
        session.info = { ...session.info, model };
      },
      update: async (patch) => {
        assertOpen();
        if (patch.title !== undefined) calls.titles.push(patch.title);
        if (patch.permissions !== undefined) {
          calls.permissions.push({ sessionID: id, rules: patch.permissions });
        }
        session.info = {
          ...session.info,
          title: patch.title ?? session.info.title,
          metadata: patch.metadata === undefined ? session.info.metadata : patch.metadata,
        };
      },
      move: async (directory) => {
        assertOpen();
        calls.moves.push({ sessionID: id, directory });
        session.info = { ...session.info, location: { directory } };
        return handleOf(session);
      },
      fork: async (checkpointMessageId) => {
        assertOpen();
        calls.forks += 1;
        const before =
          checkpointMessageId === undefined
            ? undefined
            : openCodeBeforeForInclusiveCheckpoint(
                session.messages,
                checkpointMessageId,
              );
        const copied =
          before === undefined
            ? [...session.messages]
            : session.messages.slice(
                0,
                session.messages.findIndex((message) => message.id === before),
              );
        const child: FakeSession = {
          info: {
            ...session.info,
            id: nextId("ses"),
            parentID: undefined,
          },
          messages: copied.map((message) => ({ ...message, id: nextId("msg_") })),
          instructions: session.instructions,
          environment: { ...session.environment },
        };
        sessions.set(child.info.id, child);
        emit({
          type: "session.created",
          data: {
            sessionID: child.info.id,
            parentID: undefined,
          },
        });
        return handleOf(child);
      },
      context: async () => {
        assertOpen();
        return session.messages;
      },
      durableLog: async () => {
        assertOpen();
        return { events: durable.get(id) ?? [], complete: true };
      },
      replyPermission: async (requestID, reply) => {
        assertOpen();
        calls.permissionReplies.push({ requestID, reply });
      },
      replyForm: async (formID, answer) => {
        assertOpen();
        calls.formReplies.push({ formID, answer });
      },
      cancelForm: async () => {
        assertOpen();
      },
      setEnvironment: async (variables) => {
        assertOpen();
        session.environment = { ...variables };
      },
      rpc: async (rpcID) => {
        assertOpen();
        const message = `RPC is unavailable: ${rpcID}`;
        throw new Error(message, { cause: { _tag: "RpcError", type: "rpc.unavailable", message } });
      },
      setInstructions: async (input) => {
        assertOpen();
        if (input.mode === "replace") {
          throw new OpenCodeInstructionReplaceError();
        }
        const text = input.text.trim();
        calls.instructions.push({ sessionID: id, text });
        session.instructions = text.length === 0 ? null : text;
        emit({
          type: "session.instructions.updated",
          data: {
            sessionID: id,
            delta: {
              [`api/${BB_INSTRUCTION_ENTRY_KEY}`]:
                text.length === 0 ? "removed" : "set",
            },
          },
        });
      },
    };
  };

  const runtime: FakeOpenCodeRuntime = {
    info: async () => {
      assertReady();
      return {
        version: options.version ?? "2.0.10",
        url: options.url ?? "http://127.0.0.1:9",
        appId: options.appId ?? "opencode",
      };
    },
    health: async () => healthSnapshot,
    models: async () => options.models ?? [],
    agents: async (): Promise<OpenCodeAgentCatalog> => {
      const agents = options.agents ?? [
        {
          id: "build",
          name: "Build",
          mode: "primary",
          hidden: false,
        },
        {
          id: "plan",
          name: "Plan",
          mode: "primary",
          hidden: false,
        },
      ];
      return {
        agents,
        defaultAgentId: resolveDefaultAgentId({
          agents,
          configDefaultAgent: extractConfigDefaultAgent(
            options.configEntries ?? [],
          ),
        }),
      };
    },
    skills: async () => options.skills ?? [],
    commands: async () => options.commands ?? [],
    createSession: async (input: CreateSessionInput) => {
      assertReady();
      if (input.instructions?.mode === "replace") {
        throw new OpenCodeInstructionReplaceError();
      }
      await connect();
      const id = nextId("ses");
      const session: FakeSession = {
        info: {
          id,
          title: input.title,
          agent: input.agent,
          model: input.model,
          metadata: input.metadata,
          location: input.location,
        },
        messages: [],
        instructions: null,
        environment: { ...input.environment },
      };
      if (input.permissionMode) {
        sessionRulesForPermissionMode(input.permissionMode);
      }
      sessions.set(id, session);
      if (input.permissions !== undefined) {
        calls.permissions.push({ sessionID: id, rules: input.permissions });
      }
      emit({
        type: "session.created",
        data: { sessionID: id, parentID: undefined },
      });
      const handle = handleOf(session);
      if (input.instructions) {
        await handle.setInstructions(input.instructions);
      }
      return handle;
    },
    openSession: async (sessionID) => {
      const session = sessions.get(sessionID);
      if (!session) {
        throw new Error(`Session not found: ${sessionID}`);
      }
      await connect();
      return handleOf(session);
    },
    subscribe: (sessionID, signal) => {
      const events = pump.subscribe(sessionID, signal);
      void connect().catch(() => undefined);
      return events;
    },
    emit,
    play: (event) => queueEvent(event),
    calls,
    failStream: (error: unknown) => {
      reportStreamFailure(error);
    },
    close: async () => {
      closed = true;
      await pump.close();
    },
  };
  return runtime;
}
