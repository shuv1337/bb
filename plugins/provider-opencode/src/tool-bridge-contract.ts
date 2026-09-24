import { z } from "zod";

export const BB_TOOLS_PROTOCOL = "bb.tools.v1";
export const BB_TOOLS_PROTOCOL_RANGE = { min: 1, max: 1 } as const;
export const BB_TOOLS_CLIENT = { name: "bb", version: "0.1.0" } as const;
export const BB_TOOLS_MAX_TOOLS = 128;
export const BB_TOOLS_MAX_NAME_LENGTH = 64;
export const BB_TOOLS_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
export const BB_TOOLS_DIGEST = /^[a-f0-9]{64}$/u;

export const DEFAULT_BB_TOOLS_LIMITS = {
  maxOutstandingCalls: 32,
  maxResultBytes: 1_048_576,
  maxToolsPerBinding: 128,
  maxBindings: 1024,
  ownerLeaseMs: 30_000,
  maxPendingWaitMs: 5_000,
} as const;

export const bbToolsLimitsSchema = z
  .object({
    maxOutstandingCalls: z.number().int().positive(),
    maxResultBytes: z.number().int().positive(),
    maxToolsPerBinding: z.number().int().positive(),
    maxBindings: z.number().int().positive(),
    ownerLeaseMs: z.number().int().positive(),
    maxPendingWaitMs: z.number().int().nonnegative(),
  });

export type BbToolsLimits = z.infer<typeof bbToolsLimitsSchema>;

export const bbToolsProtocolRangeSchema = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .refine((range) => range.min <= range.max, "min must not exceed max");

const contentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
]);

export const bbToolsContentItemsSchema = z.array(contentItemSchema);

const capabilitySchema = z.string().min(1);
const keySchema = z.string().min(1);

export const helloInputSchema = z
  .object({
    client: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .optional(),
    protocol: bbToolsProtocolRangeSchema.optional(),
  });

export const helloOutputSchema = z
  .object({
    protocol: z.literal(BB_TOOLS_PROTOCOL),
    version: z.number().int().positive(),
    versions: bbToolsProtocolRangeSchema,
    package: z
      .object({
        name: z.literal("opencode-bb-tools"),
        version: z.string().min(1),
      })
      ,
    install: z
      .object({
        path: z.string().min(1),
        digest: z.string().regex(BB_TOOLS_DIGEST),
      })
      ,
    generation: z.string().min(1),
    instances: z.number().int().positive(),
    features: z.object({ richFailures: z.boolean() }),
    limits: bbToolsLimitsSchema,
  });

export const helloOutputRuntimeSchema = z
  .object({
    protocol: z.string().min(1),
    version: z.number().int(),
    generation: z.string().min(1),
    versions: bbToolsProtocolRangeSchema.optional(),
    instances: z.number().int().nonnegative().optional(),
    features: z
      .object({
        richFailures: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
    package: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    install: z
      .object({
        path: z.string().optional(),
        digest: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const catalogToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  });

export const attachInputSchema = z
  .object({
    sessionID: z.string().min(1),
    tools: z.array(catalogToolSchema).min(1).max(BB_TOOLS_MAX_TOOLS),
    disallowedTools: z.array(z.string()).optional(),
    takeover: z.object({ capability: z.string().min(1) }).optional(),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const [index, tool] of input.tools.entries()) {
      if (tool.name.length > BB_TOOLS_MAX_NAME_LENGTH && /^[A-Za-z0-9_-]+$/u.test(tool.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", index, "name"],
          message: "overlong",
        });
        continue;
      }
      if (!BB_TOOLS_NAME.test(tool.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", index, "name"],
          message: "name",
        });
        continue;
      }
      if (tool.name === "execute" || tool.name.startsWith("bbt_")) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", index, "name"],
          message: "reserved",
        });
        continue;
      }
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", index, "name"],
          message: "duplicate",
        });
        continue;
      }
      seen.add(tool.name);
    }
  });

export const attachOutputSchema = z
  .object({
    bindingID: z.string().min(1),
    epoch: z.number().int().positive(),
    capability: z.string().min(1),
    generation: z.string().min(1),
    catalogDigest: z.string().regex(BB_TOOLS_DIGEST),
    ownerLeaseMs: z.number().int().positive(),
  });

export const pendingInputSchema = z
  .object({
    capability: capabilitySchema,
    acknowledged: z.array(z.string()).optional(),
    waitMs: z.number().optional(),
  });

const originSchema = z
  .object({
    rootSessionID: z.string().min(1),
    rootMessageID: z.string().min(1),
  });

const pendingCallSchema = z
  .object({
    key: keySchema,
    sessionID: z.string().min(1),
    messageID: z.string().min(1),
    callID: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown(),
    state: z.enum(["pending", "claimed"]),
    origin: originSchema,
  });

export const settledDispositionSchema = z.enum([
  "cancelled",
  "uncertain",
  "delivered",
  "rejected",
]);

export const settledNoticeSchema = z
  .object({
    key: keySchema,
    outcome: z.enum(["cancelled", "settled"]),
    disposition: settledDispositionSchema,
    reason: z.string().optional(),
  });

export const pendingOutputSchema = z
  .object({
    calls: z.array(pendingCallSchema),
    settled: z.array(settledNoticeSchema),
  });

export const claimInputSchema = z
  .object({
    capability: capabilitySchema,
    key: keySchema,
  });

export const claimOutputSchema = z.object({ key: keySchema.optional() });

export const resultInputSchema = z
  .object({
    capability: capabilitySchema,
    key: keySchema,
    success: z.boolean(),
    contentItems: bbToolsContentItemsSchema,
  });

export const emptyOutputSchema = z.object({});

export const statusInputSchema = z
  .object({
    capability: capabilitySchema.optional(),
  });

export const statusBoundOutputSchema = z
  .object({
    bound: z.literal(true),
    epoch: z.number().int(),
    generation: z.string().min(1),
    catalogDigest: z.string().min(1),
    leaseExpiresAt: z.number(),
  });

export const statusUnboundOutputSchema = z
  .object({
    bound: z.literal(false),
    generation: z.string().min(1),
  });

export const statusOutputSchema = z.discriminatedUnion("bound", [
  statusBoundOutputSchema,
  statusUnboundOutputSchema,
]);

export const detachInputSchema = statusInputSchema;
export const rejectInputSchema = z
  .object({
    capability: capabilitySchema,
    key: keySchema,
    message: z.string().min(1).optional(),
  });

export const configureInputSchema = z
  .object({
    capability: capabilitySchema,
    disallowedTools: z.array(z.string()).optional(),
  });

const invalidToolReportSchema = z
  .object({
    tool: z.string().optional(),
    reason: z.string().min(1),
    detail: z.string().min(1),
  });

const errorBase = {
  message: z.string().min(1),
};

export const protocolErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("invalid"),
      ...errorBase,
      data: z
        .object({
          tool: z.string().optional(),
          reason: z.string().min(1),
          tools: z.array(invalidToolReportSchema),
          limit: z.number().optional(),
        })
        ,
    })
    ,
  z
    .object({
      code: z.literal("owner_active"),
      ...errorBase,
      data: z.object({ retryAfterMs: z.number().nonnegative() }),
    })
    ,
  z
    .object({
      code: z.literal("overloaded"),
      ...errorBase,
      data: z.object({ limit: z.number().int().positive() }),
    })
    ,
  z
    .object({
      code: z.literal("unbound"),
      ...errorBase,
      data: z.object({}),
    })
    ,
  z
    .object({
      code: z.literal("unavailable"),
      ...errorBase,
      data: z.object({}),
    })
    ,
  z
    .object({
      code: z.literal("conflict"),
      ...errorBase,
      data: z.object({}),
    })
    ,
  z
    .object({
      code: z.literal("too_large"),
      ...errorBase,
      data: z.object({ limit: z.number().int().positive() }),
    })
    ,
]);

export const controlEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pending"),
      sessionID: z.string().min(1),
      key: keySchema,
    })
    ,
  z
    .object({
      type: z.literal("cancelled"),
      sessionID: z.string().min(1),
      key: keySchema,
      state: z.enum(["pending", "claimed"]),
      reason: z.string().min(1),
    })
    ,
]);

export const METHOD_INPUTS = {
  hello: helloInputSchema,
  attach: attachInputSchema,
  pending: pendingInputSchema,
  claim: claimInputSchema,
  result: resultInputSchema,
  status: statusInputSchema,
  detach: detachInputSchema,
  reject: rejectInputSchema,
  configure: configureInputSchema,
} as const;

export const METHOD_OUTPUTS = {
  hello: helloOutputSchema,
  attach: attachOutputSchema,
  pending: pendingOutputSchema,
  claim: claimOutputSchema,
  result: emptyOutputSchema,
  status: statusOutputSchema,
  detach: emptyOutputSchema,
  reject: emptyOutputSchema,
  configure: emptyOutputSchema,
} as const;

export const METHOD_ERRORS = {
  hello: [] as const,
  attach: ["invalid", "owner_active", "overloaded"] as const,
  pending: ["unbound"] as const,
  claim: ["unbound", "unavailable"] as const,
  result: ["unbound", "unavailable", "conflict", "too_large"] as const,
  status: [] as const,
  detach: [] as const,
  reject: ["unbound", "unavailable"] as const,
  configure: ["unbound"] as const,
} as const;

export type BbToolsMethodName = keyof typeof METHOD_INPUTS;

export type BbToolsFixture = {
  method: BbToolsMethodName | "control";
  case: string;
  produces: "success" | "parse-error" | "handler-error" | "event";
  input?: unknown;
  output?: unknown;
  error?: unknown;
  event?: unknown;
};

export function helloWireInput(): z.infer<typeof helloInputSchema> {
  return {
    client: { ...BB_TOOLS_CLIENT },
    protocol: { ...BB_TOOLS_PROTOCOL_RANGE },
  };
}

export function protocolRangesOverlap(
  left: { min: number; max: number },
  right: { min: number; max: number },
): boolean {
  return left.max >= right.min && left.min <= right.max;
}

export type BbToolsProtocolError = z.infer<typeof protocolErrorSchema>;

export function parseBbToolsInput(
  method: BbToolsMethodName,
  input: unknown,
): { ok: true } | BbToolsProtocolError {
  if (method === "hello" || method === "status" || method === "detach") return { ok: true };
  if (method === "attach") return asParsed(parseAttach(input));
  if (method === "pending") return asParsed(parsePending(input));
  if (method === "claim") return asParsed(parseKeyInput(input, "call is not pending"));
  if (method === "result") return asParsed(parseResult(input));
  if (method === "reject") return asParsed(parseKeyInput(input, "call is not pending"));
  return asParsed(parseConfigure(input));
}

export function capturedRequestIssue(
  method: string,
  input: unknown,
  fixtures: readonly BbToolsFixture[],
): string | undefined {
  if (!(method in METHOD_INPUTS)) return `unknown method ${method}`;
  const parsed = METHOD_INPUTS[method as BbToolsMethodName].safeParse(input);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "invalid request";
  const allowed = new Set<string>();
  for (const fixture of fixtures) {
    if (fixture.method !== method || fixture.produces === "parse-error" || fixture.produces === "event") continue;
    if (!isRecord(fixture.input)) continue;
    for (const key of Object.keys(fixture.input)) allowed.add(key);
  }
  if (!isRecord(input)) return "request must be an object";
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return `unexpected field ${key}`;
  }
  return undefined;
}

export function checkBbToolsFixture(fixture: BbToolsFixture): string | undefined {
  if (fixture.method === "control" || fixture.produces === "event") {
    const parsed = controlEventSchema.safeParse(fixture.event);
    return parsed.success ? undefined : "control";
  }
  const parsed = parseBbToolsInput(fixture.method, fixture.input ?? {});
  if (fixture.produces === "parse-error") {
    if (!("code" in parsed)) return "input should fail";
    return exactError(fixture.method, parsed, fixture.error);
  }
  if ("code" in parsed) return `input should parse: ${parsed.message}`;
  const input = METHOD_INPUTS[fixture.method].safeParse(fixture.input ?? {});
  if (!input.success) return `input should parse: ${input.error.issues[0]?.message ?? "invalid"}`;
  if (fixture.produces === "handler-error") return exactError(fixture.method, fixture.error, fixture.error);
  const output = METHOD_OUTPUTS[fixture.method].safeParse(fixture.output);
  return output.success ? undefined : `${fixture.method} output`;
}

function exactError(method: BbToolsMethodName, actual: unknown, expected: unknown): string | undefined {
  const shape = checkError(method, expected);
  if (shape !== undefined) return shape;
  const parsed = protocolErrorSchema.parse(expected);
  const candidate = protocolErrorSchema.safeParse(actual);
  if (!candidate.success) return "error shape";
  if (JSON.stringify(candidate.data) !== JSON.stringify(parsed)) return "error mismatch";
  return undefined;
}

function checkError(method: BbToolsMethodName, value: unknown): string | undefined {
  const parsed = protocolErrorSchema.safeParse(value);
  if (!parsed.success) return "error shape";
  const allowed = METHOD_ERRORS[method] as readonly string[];
  if (!allowed.includes(parsed.data.code)) return `unexpected ${parsed.data.code} for ${method}`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asParsed(value: BbToolsProtocolError | { ok: true }): { ok: true } | BbToolsProtocolError {
  return value;
}

function protocolError(
  code: BbToolsProtocolError["code"],
  message: string,
  data: BbToolsProtocolError["data"],
): BbToolsProtocolError {
  return protocolErrorSchema.parse({ code, message, data });
}

function structuralInvalid(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): BbToolsProtocolError {
  return protocolError("invalid", message, { reason, tools: [], ...extra });
}

function catalogInvalid(
  items: Array<{ tool?: string; reason: string; detail: string }>,
): BbToolsProtocolError {
  const first = items[0];
  return protocolError("invalid", items.map((item) => item.detail).join("; "), {
    ...(first?.tool === undefined ? {} : { tool: first.tool }),
    reason: first?.reason ?? "schema",
    tools: items.map((item) => ({
      ...(item.tool === undefined ? {} : { tool: item.tool }),
      reason: item.reason,
      detail: item.detail,
    })),
  });
}

function parseAttach(input: unknown): BbToolsProtocolError | { ok: true } {
  if (!isRecord(input) || typeof input.sessionID !== "string" || input.sessionID.length === 0) {
    return structuralInvalid("session", "sessionID is required");
  }
  if (input.takeover !== undefined) {
    if (!isRecord(input.takeover) || typeof input.takeover.capability !== "string" || input.takeover.capability.length === 0) {
      return structuralInvalid("session", "takeover.capability must be a string");
    }
  }
  const tools = parseTools(input.tools);
  if ("code" in tools) return tools;
  return { ok: true };
}

function parseTools(raw: unknown): BbToolsProtocolError | { ok: true } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return structuralInvalid("empty", "tools must be a non-empty array");
  }
  if (raw.length > BB_TOOLS_MAX_TOOLS) {
    return structuralInvalid("too_many", `tools exceed the companion limit of ${BB_TOOLS_MAX_TOOLS}`, {
      limit: BB_TOOLS_MAX_TOOLS,
    });
  }
  const seen = new Set<string>();
  const problems: Array<{ tool?: string; reason: string; detail: string }> = [];
  for (const [index, item] of raw.entries()) {
    const problem = inspectTool(item, index, seen);
    if (problem !== undefined) problems.push(problem);
  }
  if (problems.length > 0) return catalogInvalid(problems);
  return { ok: true };
}

function inspectTool(
  item: unknown,
  index: number,
  seen: Set<string>,
): { tool?: string; reason: string; detail: string } | undefined {
  if (!isRecord(item)) return { reason: "schema", detail: `tools[${index}] must be an object` };
  const { name, description, inputSchema } = item;
  if (typeof name !== "string") return { reason: "name", detail: `tools[${index}].name is not a valid tool name` };
  if (/^[A-Za-z0-9_-]+$/u.test(name) && name.length > BB_TOOLS_MAX_NAME_LENGTH) {
    return { tool: name, reason: "overlong", detail: `tools[${index}].name exceeds ${BB_TOOLS_MAX_NAME_LENGTH} characters` };
  }
  if (!BB_TOOLS_NAME.test(name)) {
    return { tool: name, reason: "name", detail: `tools[${index}].name is not a valid tool name` };
  }
  if (name === "execute" || name.startsWith("bbt_")) {
    return { tool: name, reason: "reserved", detail: `tools[${index}].name "${name}" is reserved` };
  }
  if (seen.has(name)) return { tool: name, reason: "duplicate", detail: `tools[${index}].name "${name}" is duplicated` };
  if (typeof description !== "string") {
    return { tool: name, reason: "description", detail: `tools[${index}].description must be a string` };
  }
  if (!isRecord(inputSchema)) {
    return { tool: name, reason: "schema", detail: `tools[${index}].inputSchema must be an object` };
  }
  seen.add(name);
  return undefined;
}

function capabilityOf(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.capability !== "string" || input.capability.length === 0) return undefined;
  return input.capability;
}

function parsePending(input: unknown): BbToolsProtocolError | { ok: true } {
  if (capabilityOf(input) === undefined) return protocolError("unbound", "unknown capability", {});
  return { ok: true };
}

function parseConfigure(input: unknown): BbToolsProtocolError | { ok: true } {
  if (capabilityOf(input) === undefined) return protocolError("unbound", "unknown capability", {});
  return { ok: true };
}

function parseKeyInput(input: unknown, missing: string): BbToolsProtocolError | { ok: true } {
  if (capabilityOf(input) === undefined) return protocolError("unbound", "unknown capability", {});
  if (!isRecord(input) || typeof input.key !== "string" || input.key.length === 0) {
    return protocolError("unavailable", missing, {});
  }
  return { ok: true };
}

function parseResult(input: unknown): BbToolsProtocolError | { ok: true } {
  const key = parseKeyInput(input, "call is not claimed");
  if ("code" in key) return key;
  if (!Array.isArray(isRecord(input) ? input.contentItems : undefined)) {
    return protocolError("unavailable", "contentItems are invalid", {});
  }
  for (const item of (input as { contentItems: unknown[] }).contentItems) {
    if (!isRecord(item)) return protocolError("unavailable", "contentItems are invalid", {});
    if (item.type === "inputText" && typeof item.text === "string") continue;
    if (item.type === "inputImage" && typeof item.imageUrl === "string") continue;
    return protocolError("unavailable", "contentItems are invalid", {});
  }
  return { ok: true };
}
