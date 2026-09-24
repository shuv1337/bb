import { z } from "zod";
import { OpenCodeUnauthenticatedError } from "./errors.js";
import type { OpenCodeJsonValue } from "./types.js";

export const BB_TOOLS_RPC = "bb.tools.v1";
export const BB_TOOLS_CONTROL_EVENT = `rpc.${BB_TOOLS_RPC}.control`;
export const SUPPORTED_BB_TOOLS_PROTOCOL_VERSION = 1;
export const BB_TOOL_TEARDOWN_RPC_MS = 2_000;

const contentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
]);

export const bbToolCallResultSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(contentItemSchema),
});

export const bbToolHelloOutputSchema = z.object({
  protocol: z.string(),
  version: z.number(),
  generation: z.string().min(1),
  features: z
    .object({
      richFailures: z.boolean().optional(),
    })
    .optional(),
});

export const bbToolStatusOutputSchema = z.object({
  bound: z.boolean(),
  generation: z.string().min(1),
  epoch: z.number().optional(),
});

export const bbToolAttachOutputSchema = z.object({
  capability: z.string().min(1),
  bindingID: z.string().min(1),
  generation: z.string().min(1),
  epoch: z.number(),
});

export const bbToolPendingOutputSchema = z.object({
  calls: z.array(
    z.object({
      key: z.string().min(1),
      sessionID: z.string().min(1),
      messageID: z.string().min(1).optional(),
      callID: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.unknown(),
      origin: z.object({
        rootSessionID: z.string().min(1),
        rootMessageID: z.string().min(1),
      }),
      state: z.enum(["pending", "claimed"]).optional(),
    }),
  ),
  settled: z
    .array(
      z.object({
        key: z.string().min(1),
        outcome: z.enum(["cancelled", "settled"]),
      }),
    )
    .optional(),
});

export const bbToolClaimOutputSchema = z
  .object({
    key: z.string().min(1).optional(),
  })
  .passthrough();

export const bbToolAckOutputSchema = z.object({}).passthrough();

export type BbToolCallResult = z.infer<typeof bbToolCallResultSchema>;
export type BbToolHelloOutput = z.infer<typeof bbToolHelloOutputSchema>;
export type BbToolStatusOutput = z.infer<typeof bbToolStatusOutputSchema>;
export type BbToolAttachOutput = z.infer<typeof bbToolAttachOutputSchema>;
export type BbToolPendingOutput = z.infer<typeof bbToolPendingOutputSchema>;
export type BbPendingToolCall = BbToolPendingOutput["calls"][number];

export type BbToolsRpcKind = "absent" | "unbound" | "conflict" | "timeout" | "invalid" | "failed";

export class BbToolsRpcError extends Error {
  readonly kind: BbToolsRpcKind;

  constructor(kind: BbToolsRpcKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BbToolsRpcError";
    this.kind = kind;
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
  | { kind: "ok"; generation: string };

export type BbToolsRpc = (
  rpcID: string,
  method: string,
  input: OpenCodeJsonValue,
) => Promise<unknown>;

export function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
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
  const message = failureMessage(error);
  return message.includes("unbound") || message.includes("unknown capability");
}

export function classifyBbToolsRpcError(error: unknown): "absent" | "failed" {
  if (error instanceof OpenCodeUnauthenticatedError) throw error;
  if (error instanceof BbToolsRpcError && error.kind === "absent") return "absent";
  return isCompanionAbsent(error) ? "absent" : "failed";
}

function classifyThrown(error: unknown): BbToolsRpcError {
  if (error instanceof OpenCodeUnauthenticatedError) throw error;
  if (error instanceof BbToolsRpcError) return error;
  if (isCompanionAbsent(error)) {
    return new BbToolsRpcError("absent", failureMessage(error), error);
  }
  const message = failureMessage(error);
  if (message.includes("conflict")) return new BbToolsRpcError("conflict", message, error);
  if (isUnboundRpc(error)) return new BbToolsRpcError("unbound", message, error);
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

export interface BbToolsClient {
  hello(): Promise<BbToolsHello>;
  status(capability: string, options?: BbToolsCallOptions): Promise<BbToolStatusOutput>;
  attach(
    input: {
      sessionID: string;
      disallowedTools: readonly string[];
      tools: readonly { name: string; description: string; inputSchema: unknown }[];
    },
    options?: BbToolsCallOptions,
  ): Promise<BbToolAttachOutput>;
  configure(
    input: { capability: string; disallowedTools: readonly string[] },
    options?: BbToolsCallOptions,
  ): Promise<void>;
  pending(
    input: { capability: string; acknowledged: readonly string[] },
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

function bbToolsSetupMessage(version: number, protocol: string): string {
  return `OpenCode companion ${protocol} protocol version ${version} is not supported (supported version: ${SUPPORTED_BB_TOOLS_PROTOCOL_VERSION}). Install a compatible opencode-bb-tools release with the engine's \`plugin add opencode-bb-tools\` and retry the turn.`;
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
        raw = await call("hello", {});
      } catch (error) {
        if (error instanceof OpenCodeUnauthenticatedError) throw error;
        return classifyBbToolsRpcError(error) === "absent" ? { kind: "absent" } : { kind: "failed", error };
      }
      const parsed = bbToolHelloOutputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          kind: "rejected",
          message:
            "OpenCode companion hello did not match bb.tools.v1. Install a compatible opencode-bb-tools release with the engine's `plugin add opencode-bb-tools` and retry the turn.",
        };
      }
      if (
        parsed.data.protocol !== BB_TOOLS_RPC ||
        parsed.data.version !== SUPPORTED_BB_TOOLS_PROTOCOL_VERSION
      ) {
        return {
          kind: "rejected",
          message: bbToolsSetupMessage(parsed.data.version, parsed.data.protocol),
        };
      }
      return { kind: "ok", generation: parsed.data.generation };
    },
    async status(capability, options) {
      return parse(bbToolStatusOutputSchema, await call("status", { capability }, options), "status");
    },
    async attach(input, options) {
      return parse(
        bbToolAttachOutputSchema,
        await call(
          "attach",
          {
            sessionID: input.sessionID,
            disallowedTools: [...input.disallowedTools],
            tools: input.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: toJsonValue(tool.inputSchema),
            })),
          },
          options,
        ),
        "attach",
      );
    },
    async configure(input, options) {
      parse(
        bbToolAckOutputSchema,
        await call(
          "configure",
          { capability: input.capability, disallowedTools: [...input.disallowedTools] },
          options,
        ),
        "configure",
      );
    },
    async pending(input, options) {
      return parse(
        bbToolPendingOutputSchema,
        await call(
          "pending",
          { capability: input.capability, acknowledged: [...input.acknowledged] },
          options,
        ),
        "pending",
      );
    },
    async claim(input, options) {
      parse(bbToolClaimOutputSchema, await call("claim", { capability: input.capability, key: input.key }, options), "claim");
    },
    async result(input, options) {
      parse(
        bbToolAckOutputSchema,
        await call(
          "result",
          {
            capability: input.capability,
            key: input.key,
            success: input.success,
            contentItems: input.contentItems,
          },
          options,
        ),
        "result",
      );
    },
    async reject(input, options) {
      parse(
        bbToolAckOutputSchema,
        await call(
          "reject",
          { capability: input.capability, key: input.key, message: input.message },
          options,
        ),
        "reject",
      );
    },
    async detach(input, options) {
      parse(
        bbToolAckOutputSchema,
        await call("detach", { capability: input.capability }, options),
        "detach",
      );
    },
  };
}
