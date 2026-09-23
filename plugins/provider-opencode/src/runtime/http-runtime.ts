import { OpenCode } from "@opencode/client/promise";
import { Service } from "@opencode/client/service";
import { sessionRulesForPermissionMode } from "../permissions.js";
import { toOpenCodeModel } from "../models.js";
import {
  extractConfigDefaultAgent,
  resolveDefaultAgentId,
} from "./agents.js";
import { messageFrom, sessionInfoFrom } from "./context.js";
import {
  discoveryDepsFrom,
  registrationStillLive,
  resolveAttachedRegistration,
  type LiveRegistration,
} from "./discovery.js";
import { EventPump } from "./events.js";
import {
  OpenCodeInstructionReplaceError,
  OpenCodeRuntimeNotReadyError,
  OpenCodeUnauthenticatedError,
  OpenCodeUnknownCheckpointError,
  sanitizeErrorMessage,
} from "./errors.js";
import { openCodeBeforeForInclusiveCheckpoint } from "./fork.js";
import { BB_INSTRUCTION_ENTRY_KEY } from "./types.js";
import type {
  CreateOpenCodeRuntimeOptions,
  CreateSessionInput,
  OpenCodeAgent,
  OpenCodeAgentCatalog,
  OpenCodeCommand,
  OpenCodeDiscoveryHealth,
  OpenCodeLocation,
  OpenCodeModel,
  OpenCodeModelRef,
  OpenCodeNativeEvent,
  OpenCodePromptInput,
  OpenCodeRuntime,
  OpenCodeSessionMessage,
  OpenCodeSkill,
  RuntimeSessionEvent,
  SessionHandle,
} from "./types.js";

type Client = ReturnType<typeof OpenCode.make>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const GENERIC_CLIENT_REASONS = new Set([
  "Transport",
  "UnexpectedStatus",
  "UnsupportedContentType",
  "MalformedResponse",
  "SseEventTooLarge",
]);

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isUnauthenticated(error: unknown): boolean {
  return causeChain(error).some((value) => {
    if (!isRecord(value)) return false;
    if (typeof value.status === "number" && value.status === 401) return true;
    return value._tag === "UnauthorizedError";
  });
}

function clientMessage(error: unknown): string {
  let fallback = "OpenCode request failed";
  for (const value of causeChain(error)) {
    if (!isRecord(value)) continue;
    if (typeof value.message !== "string" || value.message.length === 0) continue;
    const message = sanitizeErrorMessage(value.message);
    if (!GENERIC_CLIENT_REASONS.has(message)) return message;
    fallback = message;
  }
  return fallback;
}

function classifyClientError(error: unknown): Error {
  if (isUnauthenticated(error)) {
    return new OpenCodeUnauthenticatedError(clientMessage(error), {
      cause: error,
    });
  }
  return new Error(clientMessage(error), { cause: error });
}

function wrapClientError(error: unknown): never {
  throw classifyClientError(error);
}

async function throwUnauthorized(response: Response): Promise<never> {
  let payload: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  } else {
    await response.body?.cancel()?.catch(() => undefined);
  }
  const cause: Record<string, unknown> = { status: response.status };
  if (isRecord(payload)) {
    if (typeof payload._tag === "string") cause._tag = payload._tag;
    if (typeof payload.message === "string") cause.message = payload.message;
  }
  const message =
    typeof cause.message === "string" && cause.message.length > 0
      ? cause.message
      : "OpenCode rejected authentication";
  throw new Error(sanitizeErrorMessage(message), { cause });
}

function fetchRejectingUnauthorized(
  fetchImpl: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 401) return response;
    return throwUnauthorized(response);
  };
}

function usableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.port !== "0";
  } catch {
    return false;
  }
}

function clientFor(
  registration: LiveRegistration,
  fetchImpl: typeof globalThis.fetch,
): Client {
  return OpenCode.make({
    baseUrl: registration.url,
    headers: Service.headers({
      url: registration.url,
      auth:
        registration.password === undefined
          ? undefined
          : {
              type: "basic",
              username: "opencode",
              password: registration.password,
            },
    }),
    fetch: fetchRejectingUnauthorized(fetchImpl),
  });
}

export class HttpOpenCodeRuntime implements OpenCodeRuntime {
  private client: Client | null = null;
  private registration: LiveRegistration | null = null;
  private pump: EventPump | null = null;
  private closed = false;
  private streamFailure: OpenCodeUnauthenticatedError | null = null;
  private watchedPump: EventPump | null = null;
  private healthSnapshot: OpenCodeDiscoveryHealth;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly refreshAttachment: () => Promise<{
    health: OpenCodeDiscoveryHealth;
    registration: LiveRegistration | null;
  }>;

  constructor(input: {
    health: OpenCodeDiscoveryHealth;
    registration: LiveRegistration | null;
    fetchImpl: typeof globalThis.fetch;
    refreshAttachment: () => Promise<{
      health: OpenCodeDiscoveryHealth;
      registration: LiveRegistration | null;
    }>;
  }) {
    this.healthSnapshot = input.health;
    this.fetchImpl = input.fetchImpl;
    this.refreshAttachment = input.refreshAttachment;
    if (input.registration && usableUrl(input.registration.url)) {
      this.attach(input.registration);
    }
  }

  async info(): Promise<{ version: string; url: string; appId: string | null }> {
    this.assertOpen();
    const client = this.requireClient();
    try {
      const info = await client.server.info();
      return {
        version: info.version,
        url: this.registration?.url ?? "",
        appId: this.healthSnapshot.appId,
      };
    } catch (error) {
      wrapClientError(error);
    }
  }

  async health(): Promise<OpenCodeDiscoveryHealth> {
    this.assertOpen();
    const attached = await this.refreshAttachment();
    this.assertOpen();
    if (
      attached.health.status === "ready" &&
      attached.registration &&
      usableUrl(attached.registration.url)
    ) {
      await this.replaceClient(attached.registration);
      this.assertOpen();
      if (this.streamFailure === null) {
        this.healthSnapshot = attached.health;
      } else {
        this.healthSnapshot = {
          ...attached.health,
          status: "unauthenticated",
          statusMessage: this.streamFailure.message,
        };
      }
      return this.withStreamState(this.healthSnapshot);
    }
    if (
      attached.health.status === "unauthenticated" ||
      attached.health.status === "expired"
    ) {
      await this.detachClient(
        new OpenCodeUnauthenticatedError(
          attached.health.statusMessage ?? "OpenCode rejected authentication",
        ),
      );
      this.healthSnapshot = attached.health;
      return this.healthSnapshot;
    }
    const reported: OpenCodeDiscoveryHealth =
      attached.health.status === "ready"
        ? {
            ...attached.health,
            status: "unknown",
            statusMessage: "OpenCode service is not attached",
          }
        : attached.health;
    if (this.client === null || this.healthSnapshot.status !== "ready") {
      this.healthSnapshot = reported;
    }
    return reported;
  }

  async models(location: OpenCodeLocation): Promise<OpenCodeModel[]> {
    this.assertReady();
    const client = this.requireClient();
    try {
      const listed = await client.model.list({ location });
      let defaultRef: {
        providerID: string;
        id: string;
        variant?: string;
      } | null = null;
      try {
        const def = await client.model.default({ location });
        if (def.data) {
          defaultRef = {
            providerID: def.data.providerID,
            id: def.data.id,
            variant:
              "variant" in def.data && typeof def.data.variant === "string"
                ? def.data.variant
                : undefined,
          };
        }
      } catch {
        defaultRef = null;
      }
      return (listed.data ?? [])
        .filter((model) => model.enabled)
        .map((model) => {
          const isDefault =
            defaultRef !== null &&
            model.providerID === defaultRef.providerID &&
            model.id === defaultRef.id;
          return toOpenCodeModel({
            providerID: model.providerID,
            id: model.id,
            modelID: model.modelID,
            name: model.name,
            variants: model.variants,
            enabled: model.enabled,
            isDefault,
            defaultVariant: isDefault ? defaultRef?.variant : undefined,
            limit: model.limit,
          });
        });
    } catch (error) {
      wrapClientError(error);
    }
  }

  async agents(location: OpenCodeLocation): Promise<OpenCodeAgentCatalog> {
    this.assertReady();
    const client = this.requireClient();
    try {
      const listed = await client.agent.list({ location });
      const agents: OpenCodeAgent[] = (listed.data ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        mode: agent.mode,
        hidden: agent.hidden,
        description: agent.description,
      }));
      let configDefault: string | null = null;
      try {
        const config = await client.config.get({ location });
        configDefault = extractConfigDefaultAgent(config);
      } catch {
        configDefault = null;
      }
      return {
        agents,
        defaultAgentId: resolveDefaultAgentId({
          agents,
          configDefaultAgent: configDefault,
        }),
      };
    } catch (error) {
      wrapClientError(error);
    }
  }

  async skills(location: OpenCodeLocation): Promise<OpenCodeSkill[]> {
    this.assertReady();
    const client = this.requireClient();
    try {
      const listed = await client.skill.list({ location });
      return (listed.data ?? []).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
      }));
    } catch (error) {
      wrapClientError(error);
    }
  }

  async commands(location: OpenCodeLocation): Promise<OpenCodeCommand[]> {
    this.assertReady();
    const client = this.requireClient();
    try {
      const listed = await client.command.list({ location });
      return (listed.data ?? []).map((command) => ({
        name: command.name,
        description: command.description,
      }));
    } catch (error) {
      wrapClientError(error);
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionHandle> {
    this.assertReady();
    await this.requireConnectedPump();
    if (input.instructions?.mode === "replace") {
      throw new OpenCodeInstructionReplaceError();
    }
    const client = this.requireClient();
    const permissions =
      input.permissions ??
      (input.permissionMode
        ? sessionRulesForPermissionMode(input.permissionMode)
        : undefined);
    let created: unknown;
    try {
      created = await client.session.create({
        location: input.location,
        title: input.title,
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permissions,
      });
    } catch (error) {
      wrapClientError(error);
    }
    const info = sessionInfoFrom(created, input.location);
    const handle = this.handle(info);
    try {
      if (input.instructions && input.instructions.text.trim().length > 0) {
        await handle.setInstructions(input.instructions);
      }
      if (input.environment && Object.keys(input.environment).length > 0) {
        await handle.setEnvironment(input.environment);
      }
    } catch (error) {
      await client.session
        .remove({ sessionID: info.id })
        .catch(() => undefined);
      throw error;
    }
    return handle;
  }

  async openSession(sessionID: string): Promise<SessionHandle> {
    this.assertReady();
    await this.requireConnectedPump();
    const client = this.requireClient();
    try {
      const raw = await client.session.get({ sessionID });
      return this.handle(sessionInfoFrom(raw, { directory: "" }));
    } catch (error) {
      wrapClientError(error);
    }
  }

  subscribe(
    sessionID: string,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeSessionEvent> {
    this.assertOpen();
    const pump = this.pump;
    if (pump === null) {
      throw new OpenCodeRuntimeNotReadyError("OpenCode event stream is not attached");
    }
    const events = pump.subscribe(sessionID, signal);
    this.watchPump(pump);
    return events;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.detachClient(
      new OpenCodeRuntimeNotReadyError("OpenCode runtime is closed"),
    );
  }

  private handle(info: { id: string; location: OpenCodeLocation }): SessionHandle {
    const runtime = this;
    const id = info.id;
    const location = info.location;
    const run = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
      runtime.assertReady();
      const client = runtime.requireClient();
      try {
        return await fn(client);
      } catch (error) {
        wrapClientError(error);
      }
    };
    return {
      id,
      location,
      info: () =>
        run(async (client) =>
          sessionInfoFrom(await client.session.get({ sessionID: id }), location),
        ),
      prompt: (input: OpenCodePromptInput) =>
        run(async (client) => {
          await client.session.prompt({
            sessionID: id,
            text: input.text,
            skills: input.skills?.map((skill) => ({ id: skill.id })),
            files: input.files?.map((file) => ({
              uri: file.uri,
              name: file.name,
            })),
            delivery: input.delivery,
            id: input.id,
          });
        }),
      command: (input) =>
        run(async (client) => {
          await client.session.command({
            sessionID: id,
            name: input.name,
            text: input.text ?? "",
          });
        }),
      compact: () =>
        run(async (client) => {
          await client.session.compact({ sessionID: id });
        }),
      interrupt: () =>
        run(async (client) => {
          await client.session.interrupt({ sessionID: id });
        }),
      switchAgent: (agent) =>
        run(async (client) => {
          await client.session.switchAgent({ sessionID: id, agent });
        }),
      switchModel: (model: OpenCodeModelRef) =>
        run(async (client) => {
          await client.session.switchModel({
            sessionID: id,
            model: {
              id: model.id,
              providerID: model.providerID,
              variant: model.variant,
            },
          });
        }),
      update: (patch) =>
        run(async (client) => {
          await client.session.update({
            sessionID: id,
            title: patch.title,
            permissions: patch.permissions,
          });
        }),
      fork: async (checkpointMessageId) => {
        runtime.assertReady();
        const client = runtime.requireClient();
        try {
          const context = await client.session.context({ sessionID: id });
          const messages = context
            .map(messageFrom)
            .filter((message): message is OpenCodeSessionMessage => message !== null);
          const before =
            checkpointMessageId === undefined
              ? undefined
              : openCodeBeforeForInclusiveCheckpoint(
                  messages,
                  checkpointMessageId,
                );
          const forked = await client.session.fork({
            sessionID: id,
            before,
          });
          await runtime.requireConnectedPump();
          return runtime.handle(sessionInfoFrom(forked, location));
        } catch (error) {
          if (error instanceof OpenCodeUnknownCheckpointError) throw error;
          wrapClientError(error);
        }
      },
      context: () =>
        run(async (client) =>
          (await client.session.context({ sessionID: id }))
            .map(messageFrom)
            .filter((message): message is OpenCodeSessionMessage => message !== null),
        ),
      replyPermission: (requestID, reply) =>
        run(async (client) => {
          await client.permission.reply({
            sessionID: id,
            requestID,
            decision: reply,
          });
        }),
      replyForm: (formID, answer) =>
        run(async (client) => {
          await client.session.form.reply({
            sessionID: id,
            formID,
            answer,
          });
        }),
      cancelForm: (formID) =>
        run(async (client) => {
          await client.session.form.cancel({
            sessionID: id,
            formID,
          });
        }),
      setEnvironment: (variables) =>
        run(async (client) => {
          await client.session.environment({ sessionID: id, variables });
        }),
      setInstructions: async (input) => {
        if (input.mode === "replace") {
          throw new OpenCodeInstructionReplaceError();
        }
        runtime.assertReady();
        const client = runtime.requireClient();
        try {
          const text = input.text.trim();
          if (text.length === 0) {
            await client.session.instructions.entry.remove({
              sessionID: id,
              key: BB_INSTRUCTION_ENTRY_KEY,
            });
            return;
          }
          await client.session.instructions.entry.put({
            sessionID: id,
            key: BB_INSTRUCTION_ENTRY_KEY,
            value: text,
          });
        } catch (error) {
          wrapClientError(error);
        }
      },
    };
  }

  private attach(registration: LiveRegistration): EventPump | null {
    const previous = this.pump;
    this.streamFailure = null;
    this.registration = registration;
    const client = clientFor(registration, this.fetchImpl);
    this.client = client;
    const pump = new EventPump((signal) => client.event.subscribe({ signal }), {
      isFatal: isUnauthenticated,
      describeError: (error) => classifyClientError(error).message,
    });
    this.pump = pump;
    this.armPumpWatch(pump);
    return previous;
  }

  private async replaceClient(registration: LiveRegistration): Promise<void> {
    if (
      this.client !== null &&
      this.registration?.url === registration.url &&
      this.registration.pid === registration.pid &&
      this.registration.password === registration.password
    ) {
      this.registration = registration;
      return;
    }
    const previous = this.attach(registration);
    if (previous === null) return;
    const next = this.requirePump();
    const adopted = next.adoptSubscribers(previous);
    await previous.close();
    if (adopted > 0 && !this.closed && this.pump === next) this.watchPump(next);
  }

  private async detachClient(failure: Error): Promise<void> {
    const previous = this.pump;
    this.streamFailure = null;
    this.watchedPump = null;
    this.pump = null;
    this.client = null;
    this.registration = null;
    previous?.fail(failure);
    await previous?.close();
  }

  private withStreamState(
    health: OpenCodeDiscoveryHealth,
  ): OpenCodeDiscoveryHealth {
    const pump = this.pump;
    if (health.status !== "ready" || pump === null || pump.isConnected) {
      return health;
    }
    const error = pump.lastDisconnectError;
    if (error === null) return health;
    return {
      ...health,
      status: "unknown",
      statusMessage: `OpenCode event stream disconnected: ${classifyClientError(error).message}`,
    };
  }

  private requireClient(): Client {
    if (this.client === null) {
      throw new OpenCodeRuntimeNotReadyError("OpenCode client is not attached");
    }
    return this.client;
  }

  private requirePump(): EventPump {
    if (this.pump === null) {
      throw new OpenCodeRuntimeNotReadyError("OpenCode event stream is not attached");
    }
    return this.pump;
  }

  private armPumpWatch(pump: EventPump): void {
    if (this.watchedPump === pump) return;
    this.watchedPump = pump;
    void pump.whenStopped().catch((error: unknown) => {
      if (this.closed || this.pump !== pump) return;
      this.reportStreamFailure(pump, error);
    });
  }

  private watchPump(pump: EventPump): void {
    this.armPumpWatch(pump);
    void pump.ensureRunning().catch((error: unknown) => {
      if (this.closed || this.pump !== pump) return;
      this.reportStreamFailure(pump, error);
    });
  }

  private async requireConnectedPump(): Promise<void> {
    const pump = this.requirePump();
    try {
      await pump.ensureRunning();
    } catch (error) {
      if (this.closed || this.pump !== pump) throw error;
      throw this.reportStreamFailure(pump, error);
    }
  }

  private reportStreamFailure(pump: EventPump, error: unknown): Error {
    const classified = this.streamFailure ?? classifyClientError(error);
    if (!(classified instanceof OpenCodeUnauthenticatedError)) {
      return classified;
    }
    this.streamFailure = classified;
    this.healthSnapshot = {
      ...this.healthSnapshot,
      status: "unauthenticated",
      statusMessage: classified.message,
    };
    pump.fail(classified);
    return classified;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new OpenCodeRuntimeNotReadyError("OpenCode runtime is closed");
    }
  }

  private assertReady(): void {
    this.assertOpen();
    if (
      this.healthSnapshot.status === "unauthenticated" ||
      this.healthSnapshot.status === "expired"
    ) {
      throw new OpenCodeUnauthenticatedError(
        this.healthSnapshot.statusMessage ?? "OpenCode rejected authentication",
      );
    }
    if (
      this.healthSnapshot.status !== "ready" ||
      this.client === null ||
      this.registration === null ||
      !usableUrl(this.registration.url)
    ) {
      throw new OpenCodeRuntimeNotReadyError(
        this.healthSnapshot.statusMessage ?? "OpenCode v2 service is not ready",
      );
    }
  }
}

export async function createHttpOpenCodeRuntime(
  options: CreateOpenCodeRuntimeOptions = {},
): Promise<OpenCodeRuntime> {
  const deps = discoveryDepsFrom(options);
  const attached = await resolveAttachedRegistration(deps);
  type Cached = {
    health: OpenCodeDiscoveryHealth;
    registration: LiveRegistration;
    explicit: boolean;
  };
  const cacheOf = (
    next: Awaited<ReturnType<typeof resolveAttachedRegistration>>,
  ): Cached | null =>
    next.health.status === "ready" && next.registration !== null
      ? {
          health: next.health,
          registration: next.registration,
          explicit: next.explicit,
        }
      : null;
  let cached = cacheOf(attached);
  return new HttpOpenCodeRuntime({
    health: attached.health,
    registration: attached.registration,
    fetchImpl: deps.fetch,
    refreshAttachment: async () => {
      if (
        cached !== null &&
        (await registrationStillLive(deps, cached.registration, cached.explicit))
      ) {
        return { health: cached.health, registration: cached.registration };
      }
      const next = await resolveAttachedRegistration(deps);
      cached = cacheOf(next);
      return { health: next.health, registration: next.registration };
    },
  });
}

export type { OpenCodeNativeEvent };
