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
    bbThreadId: z.string().min(1).optional(),
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

export function checkBbToolsFixture(fixture: BbToolsFixture): string | undefined {
  if (fixture.method === "control" || fixture.produces === "event") {
    const parsed = controlEventSchema.safeParse(fixture.event);
    return parsed.success ? undefined : "control";
  }
  const inputSchema = METHOD_INPUTS[fixture.method];
  const input = inputSchema.safeParse(fixture.input ?? {});
  if (fixture.produces === "parse-error") {
    if (input.success) return "input should fail";
    return checkError(fixture.method, fixture.error);
  }
  if (!input.success) return `input should parse: ${input.error.issues[0]?.message ?? "invalid"}`;
  if (fixture.produces === "handler-error") return checkError(fixture.method, fixture.error);
  const output = METHOD_OUTPUTS[fixture.method].safeParse(fixture.output);
  return output.success ? undefined : `${fixture.method} output`;
}

function checkError(method: BbToolsMethodName, value: unknown): string | undefined {
  const parsed = protocolErrorSchema.safeParse(value);
  if (!parsed.success) return "error shape";
  const allowed = METHOD_ERRORS[method] as readonly string[];
  if (!allowed.includes(parsed.data.code)) return `unexpected ${parsed.data.code} for ${method}`;
  return undefined;
}
