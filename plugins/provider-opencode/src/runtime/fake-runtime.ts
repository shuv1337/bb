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
  OpenCodeDiscoveryHealth,
  OpenCodeLocation,
  OpenCodeModel,
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
};

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
  failStream(error: unknown): void;
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
  const pushQueue: unknown[][] = [];
  const queuedBeforeConnect: unknown[] = [];
  const pump = new EventPump(async function* (signal) {
    yield { type: "server.connected", data: {} };
    const local: unknown[] = [];
    while (queuedBeforeConnect.length > 0) {
      const pending = queuedBeforeConnect.shift();
      if (pending !== undefined) local.push(pending);
    }
    pushQueue.push(local);
    try {
      while (!signal.aborted) {
        const item = local.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally {
      const index = pushQueue.indexOf(local);
      if (index >= 0) pushQueue.splice(index, 1);
    }
  });

  const emit = (event: Record<string, unknown>) => {
    if (pushQueue.length === 0) {
      queuedBeforeConnect.push(event);
      return;
    }
    for (const queue of pushQueue) queue.push(event);
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
    const assertOpen = () => {
      if (closed) {
        throw new OpenCodeRuntimeNotReadyError("OpenCode runtime is closed");
      }
    };
    return {
      id,
      location: session.info.location,
      info: async () => {
        assertOpen();
        return session.info;
      },
      prompt: async (input: OpenCodePromptInput) => {
        assertOpen();
        const messageId = input.id ?? nextId("msg_");
        session.messages.push({
          id: messageId,
          type: "user",
          text: input.text,
        });
        emit({
          type: "session.inbox.enqueued",
          data: { sessionID: id, inboxID: messageId },
        });
      },
      command: async (input) => {
        assertOpen();
        session.messages.push({
          id: nextId("msg_"),
          type: "user",
          text: `/${input.name} ${input.text ?? ""}`.trim(),
        });
      },
      compact: async () => {
        assertOpen();
        emit({
          type: "session.compaction.started",
          data: { sessionID: id, reason: "manual" },
        });
      },
      interrupt: async () => {
        assertOpen();
        emit({
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
        session.info = {
          ...session.info,
          title: patch.title ?? session.info.title,
        };
      },
      fork: async (checkpointMessageId) => {
        assertOpen();
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
      replyPermission: async () => {
        assertOpen();
      },
      replyForm: async () => {
        assertOpen();
      },
      cancelForm: async () => {
        assertOpen();
      },
      setEnvironment: async (variables) => {
        assertOpen();
        session.environment = { ...variables };
      },
      setInstructions: async (input) => {
        assertOpen();
        if (input.mode === "replace") {
          throw new OpenCodeInstructionReplaceError();
        }
        const text = input.text.trim();
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
      if (healthSnapshot.status !== "ready") {
        throw new OpenCodeRuntimeNotReadyError(
          healthSnapshot.statusMessage ?? "not ready",
        );
      }
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
      if (healthSnapshot.status !== "ready") {
        throw new OpenCodeRuntimeNotReadyError(
          healthSnapshot.statusMessage ?? "not ready",
        );
      }
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
