import type {
  OpenCodeLocation,
  OpenCodeModelRef,
  OpenCodeSessionInfo,
  OpenCodeSessionMessage,
  OpenCodeTokenUsage,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const REDACT_KEY = /thoughtsignature|password|authorization|passwd|secret/i;

export function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (REDACT_KEY.test(key)) continue;
    out[key] = sanitizeUnknown(nested);
  }
  return out;
}

function tokenUsageFrom(raw: unknown): OpenCodeTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    typeof raw.input !== "number" ||
    typeof raw.output !== "number" ||
    typeof raw.reasoning !== "number"
  ) {
    return undefined;
  }
  const cache = isRecord(raw.cache) ? raw.cache : {};
  return {
    input: raw.input,
    output: raw.output,
    reasoning: raw.reasoning,
    cache: {
      read: typeof cache.read === "number" ? cache.read : 0,
      write: typeof cache.write === "number" ? cache.write : 0,
    },
  };
}

function modelRefFrom(raw: unknown): OpenCodeModelRef | undefined {
  if (
    isRecord(raw) &&
    typeof raw.id === "string" &&
    typeof raw.providerID === "string"
  ) {
    return {
      id: raw.id,
      providerID: raw.providerID,
      variant: typeof raw.variant === "string" ? raw.variant : undefined,
    };
  }
  return undefined;
}

export function sessionInfoFrom(
  raw: unknown,
  fallbackLocation: OpenCodeLocation,
): OpenCodeSessionInfo {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new Error("OpenCode session payload missing id");
  }
  const location =
    isRecord(raw.location) && typeof raw.location.directory === "string"
      ? { directory: raw.location.directory }
      : fallbackLocation;
  const outcome =
    raw.outcome === "succeeded" ||
    raw.outcome === "failed" ||
    raw.outcome === "interrupted"
      ? raw.outcome
      : undefined;
  return {
    id: raw.id,
    parentID: typeof raw.parentID === "string" ? raw.parentID : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    agent: typeof raw.agent === "string" ? raw.agent : undefined,
    model: modelRefFrom(raw.model),
    metadata: isRecord(raw.metadata)
      ? (sanitizeUnknown(raw.metadata) as Record<string, unknown>)
      : undefined,
    location,
    tokens: tokenUsageFrom(raw.tokens),
    cost: typeof raw.cost === "number" ? raw.cost : undefined,
    outcome,
  };
}

export function messageFrom(raw: unknown): OpenCodeSessionMessage | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const sanitized = sanitizeUnknown(raw) as Record<string, unknown>;
  return {
    id: raw.id,
    type: typeof raw.type === "string" ? raw.type : "unknown",
    text: typeof sanitized.text === "string" ? sanitized.text : undefined,
    agent: typeof sanitized.agent === "string" ? sanitized.agent : undefined,
    model: modelRefFrom(sanitized.model),
    skill: typeof sanitized.skill === "string" ? sanitized.skill : undefined,
    finish: typeof sanitized.finish === "string" ? sanitized.finish : undefined,
    tokens: tokenUsageFrom(sanitized.tokens),
    cost: typeof sanitized.cost === "number" ? sanitized.cost : undefined,
    content: sanitized.content,
  };
}
