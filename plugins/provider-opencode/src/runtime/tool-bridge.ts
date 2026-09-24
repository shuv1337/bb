import { z } from "zod";
import {
  attachOutputSchema,
  BB_TOOLS_PROTOCOL,
  BB_TOOLS_PROTOCOL_RANGE,
  bbToolsContentItemsSchema,
  bbToolsLimitsSchema,
  claimOutputSchema,
  configureInputSchema,
  DEFAULT_BB_TOOLS_LIMITS,
  emptyOutputSchema,
  helloOutputRuntimeSchema,
  helloOutputSchema,
  helloWireInput,
  pendingInputSchema,
  pendingOutputSchema,
  protocolRangesOverlap,
  rejectInputSchema,
  resultInputSchema,
  statusOutputSchema,
  type BbToolsLimits,
} from "../tool-bridge-contract.js";
import { OpenCodeUnauthenticatedError } from "./errors.js";
import type { OpenCodeJsonValue } from "./types.js";

export const BB_TOOLS_RPC = BB_TOOLS_PROTOCOL;
export const BB_TOOLS_CONTROL_EVENT = `rpc.${BB_TOOLS_RPC}.control`;
export const SUPPORTED_BB_TOOLS_PROTOCOL_VERSION = BB_TOOLS_PROTOCOL_RANGE.max;
export const BB_TOOL_TEARDOWN_RPC_MS = 2_000;

export {
  BB_TOOLS_PROTOCOL_RANGE,
  DEFAULT_BB_TOOLS_LIMITS,
  helloWireInput,
  protocolRangesOverlap,
};
export type { BbToolsLimits };

export const bbToolCallResultSchema = z.object({
  success: z.boolean(),
  contentItems: bbToolsContentItemsSchema,
});

export const bbToolHelloOutputSchema = helloOutputRuntimeSchema;
export const bbToolStatusOutputSchema = statusOutputSchema;
export const bbToolAttachOutputSchema = attachOutputSchema;
export const bbToolPendingOutputSchema = pendingOutputSchema;
export const bbToolClaimOutputSchema = claimOutputSchema;
export const bbToolAckOutputSchema = emptyOutputSchema;

export type BbToolCallResult = z.infer<typeof bbToolCallResultSchema>;
export type BbToolHelloOutput = z.infer<typeof helloOutputSchema>;
export type BbToolStatusOutput = z.infer<typeof bbToolStatusOutputSchema>;
export type BbToolAttachOutput = z.infer<typeof bbToolAttachOutputSchema>;
export type BbToolPendingOutput = z.infer<typeof bbToolPendingOutputSchema>;
export type BbPendingToolCall = BbToolPendingOutput["calls"][number];

const PROTOCOL_CODES = new Set([
  "invalid",
  "owner_active",
  "overloaded",
  "unbound",
  "unavailable",
  "conflict",
  "too_large",
]);

export type BbToolsRpcKind =
  | "absent"
  | "unbound"
  | "conflict"
  | "timeout"
  | "invalid"
  | "failed"
  | "owner_active"
  | "overloaded"
  | "too_large";

export class BbToolsRpcError extends Error {
  readonly kind: BbToolsRpcKind;
  readonly code: string | undefined;
  readonly data: Record<string, unknown>;

  constructor(
    kind: BbToolsRpcKind,
    message: string,
    cause?: unknown,
    extra?: { code?: string; data?: Record<string, unknown> },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BbToolsRpcError";
    this.kind = kind;
    this.code = extra?.code;
    this.data = extra?.data ?? {};
  }
}

export class BbToolsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BbToolsSetupError";
  }
}

export type BbToolsHello =
  | { kind: "absent" }
  | { kind: "rejected"; message: string }
  | { kind: "failed"; error: unknown }
  | {
      kind: "ok";
      generation: string;
      versions: { min: number; max: number };
      instances: number;
      features: { richFailures: boolean };
      limits: BbToolsLimits;
    };

export type BbToolsRpc = (
  rpcID: string,
  method: string,
  input: OpenCodeJsonValue,
) => Promise<unknown>;

export function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

const REDACTED = "[redacted]";

export function redactCompanionSecrets<T>(value: T, secrets: readonly string[]): T {
  return redactValue(value, secrets.filter((item) => item.length > 0)) as T;
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "capability" || key === "takeover") {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(entry, secrets);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompanionAbsent(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (record.type === "rpc.unavailable") return true;
      if (record.kind === "absent") return true;
      if (typeof record.message === "string" && record.message === `RPC is unavailable: ${BB_TOOLS_RPC}`) {
        return true;
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return false;
}

export function isUnboundRpc(error: unknown): boolean {
  if (error instanceof BbToolsRpcError && error.kind === "unbound") return true;
  const message = failureMessage(error);
  return message.includes("unbound") || message.includes("unknown capability");
}

export function classifyBbToolsRpcError(error: unknown): "absent" | "failed" {
  if (error instanceof OpenCodeUnauthenticatedError) throw error;
  if (error instanceof BbToolsRpcError && error.kind === "absent") return "absent";
  return isCompanionAbsent(error) ? "absent" : "failed";
}

function protocolFailure(
  error: unknown,
): { code: string; message: string; data: Record<string, unknown> } | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!isRecord(current)) break;
    const type = typeof current.type === "string" ? current.type : typeof current.code === "string" ? current.code : undefined;
    if (type !== undefined && PROTOCOL_CODES.has(type)) {
      return {
        code: type,
        message: typeof current.message === "string" && current.message.length > 0 ? current.message : failureMessage(error),
        data: isRecord(current.data) ? current.data : {},
      };
    }
    current = current.cause;
  }
  return undefined;
}

function kindForCode(code: string): BbToolsRpcKind {
  if (code === "unbound") return "unbound";
  if (code === "conflict") return "conflict";
  if (code === "too_large") return "too_large";
  if (code === "owner_active") return "owner_active";
  if (code === "overloaded") return "overloaded";
  if (code === "invalid") return "invalid";
  return "failed";
}

function classifyThrown(error: unknown): BbToolsRpcError {
  if (error instanceof OpenCodeUnauthenticatedError) throw error;
  if (error instanceof BbToolsRpcError) return error;
  if (isCompanionAbsent(error)) {
    return new BbToolsRpcError("absent", failureMessage(error), error);
  }
  const protocol = protocolFailure(error);
  if (protocol !== undefined) {
    return new BbToolsRpcError(kindForCode(protocol.code), protocol.message, error, {
      code: protocol.code,
      data: protocol.data,
    });
  }
  const message = failureMessage(error);
  if (message.includes("conflict")) return new BbToolsRpcError("conflict", message, error, { code: "conflict" });
  if (isUnboundRpc(error)) return new BbToolsRpcError("unbound", message, error, { code: "unbound" });
  if (message === "bb tool companion RPC timed out") {
    return new BbToolsRpcError("timeout", message, error);
  }
  return new BbToolsRpcError("failed", message, error);
}

export function toJsonValue(value: unknown): OpenCodeJsonValue {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BbToolsRpcError("timeout", "bb tool companion RPC timed out")), ms);
    timer.unref?.();
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export type BbToolsCallOptions = {
  timeoutMs?: number;
};

export type BbToolsAttachInput = {
  sessionID: string;
  disallowedTools: readonly string[];
  tools: readonly { name: string; description: string; inputSchema: unknown }[];
  takeover?: { capability: string };
};

export interface BbToolsClient {
  hello(): Promise<BbToolsHello>;
  status(capability: string, options?: BbToolsCallOptions): Promise<BbToolStatusOutput>;
  attach(input: BbToolsAttachInput, options?: BbToolsCallOptions): Promise<BbToolAttachOutput>;
  configure(
    input: { capability: string; disallowedTools: readonly string[] },
    options?: BbToolsCallOptions,
  ): Promise<void>;
  pending(
    input: { capability: string; acknowledged: readonly string[]; waitMs?: number },
    options?: BbToolsCallOptions,
  ): Promise<BbToolPendingOutput>;
  claim(input: { capability: string; key: string }, options?: BbToolsCallOptions): Promise<void>;
  result(
    input: {
      capability: string;
      key: string;
      success: boolean;
      contentItems: BbToolCallResult["contentItems"];
    },
    options?: BbToolsCallOptions,
  ): Promise<void>;
  reject(
    input: { capability: string; key: string; message: string },
    options?: BbToolsCallOptions,
  ): Promise<void>;
  detach(input: { capability: string }, options?: BbToolsCallOptions): Promise<void>;
}

function bbToolsSetupMessage(version: number, protocol: string, versions: { min: number; max: number }): string {
  return `OpenCode companion ${protocol} protocol version ${version} (range ${versions.min}-${versions.max}) is not supported (supported version: ${SUPPORTED_BB_TOOLS_PROTOCOL_VERSION}). Install a compatible opencode-bb-tools release with the engine's \`plugin add opencode-bb-tools\` and retry the turn.`;
}

function limitsFrom(value: unknown): BbToolsLimits {
  const parsed = bbToolsLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_BB_TOOLS_LIMITS };
}

export function createBbToolsClient(rpc: BbToolsRpc): BbToolsClient {
  async function call(method: string, input: OpenCodeJsonValue, options?: BbToolsCallOptions): Promise<unknown> {
    const work = rpc(BB_TOOLS_RPC, method, input);
    try {
      return await (options?.timeoutMs === undefined ? work : withTimeout(work, options.timeoutMs));
    } catch (error) {
      throw classifyThrown(error);
    }
  }

  function parse<T>(schema: z.ZodType<T>, raw: unknown, method: string): T {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new BbToolsRpcError(
      "invalid",
      `OpenCode companion ${method} did not match bb.tools.v1`,
    );
  }

  return {
    async hello(): Promise<BbToolsHello> {
      let raw: unknown;
      try {
        raw = await call("hello", helloWireInput());
      } catch (error) {
        if (error instanceof OpenCodeUnauthenticatedError) throw error;
        return classifyBbToolsRpcError(error) === "absent" ? { kind: "absent" } : { kind: "failed", error };
      }
      const strict = helloOutputSchema.safeParse(raw);
      const loose = strict.success ? strict : helloOutputRuntimeSchema.safeParse(raw);
      if (!loose.success) {
        return {
          kind: "rejected",
          message:
            "OpenCode companion hello did not match bb.tools.v1. Install a compatible opencode-bb-tools release with the engine's `plugin add opencode-bb-tools` and retry the turn.",
        };
      }
      const versions = strict.success
        ? strict.data.versions
        : loose.data.versions ?? { min: loose.data.version, max: loose.data.version };
      if (loose.data.protocol !== BB_TOOLS_RPC || !protocolRangesOverlap(versions, BB_TOOLS_PROTOCOL_RANGE)) {
        return {
          kind: "rejected",
          message: bbToolsSetupMessage(loose.data.version, loose.data.protocol, versions),
        };
      }
      return {
        kind: "ok",
        generation: loose.data.generation,
        versions,
        instances: strict.success ? strict.data.instances : loose.data.instances ?? 1,
        features: {
          richFailures: strict.success
            ? strict.data.features.richFailures
            : loose.data.features?.richFailures === true,
        },
        limits: limitsFrom(strict.success ? strict.data.limits : loose.data.limits),
      };
    },
    async status(capability, options) {
      return parse(bbToolStatusOutputSchema, await call("status", { capability }, options), "status");
    },
    async attach(input, options) {
      const wire = {
        sessionID: input.sessionID,
        disallowedTools: [...input.disallowedTools],
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toJsonValue(tool.inputSchema),
        })),
        ...(input.takeover === undefined ? {} : { takeover: { capability: input.takeover.capability } }),
      };
      return parse(bbToolAttachOutputSchema, await call("attach", toJsonValue(wire), options), "attach");
    },
    async configure(input, options) {
      const wire = { capability: input.capability, disallowedTools: [...input.disallowedTools] };
      parse(configureInputSchema, wire, "configure");
      parse(bbToolAckOutputSchema, await call("configure", wire, options), "configure");
    },
    async pending(input, options) {
      const wire = {
        capability: input.capability,
        acknowledged: [...input.acknowledged],
        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      };
      parse(pendingInputSchema, wire, "pending");
      return parse(bbToolPendingOutputSchema, await call("pending", wire, options), "pending");
    },
    async claim(input, options) {
      parse(bbToolClaimOutputSchema, await call("claim", { capability: input.capability, key: input.key }, options), "claim");
    },
    async result(input, options) {
      const wire = {
        capability: input.capability,
        key: input.key,
        success: input.success,
        contentItems: input.contentItems,
      };
      parse(resultInputSchema, wire, "result");
      parse(bbToolAckOutputSchema, await call("result", wire, options), "result");
    },
    async reject(input, options) {
      const wire = { capability: input.capability, key: input.key, message: input.message };
      parse(rejectInputSchema, wire, "reject");
      parse(bbToolAckOutputSchema, await call("reject", wire, options), "reject");
    },
    async detach(input, options) {
      parse(bbToolAckOutputSchema, await call("detach", { capability: input.capability }, options), "detach");
    },
  };
}
