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

const CREDENTIAL_WORDS = new Set([
  "password",
  "passwords",
  "passwd",
  "secret",
  "secrets",
  "authorization",
  "token",
  "apikey",
  "secretkey",
  "privatekey",
  "thoughtsignature",
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isRedactedKey(key: string): boolean {
  const words = keyWords(key);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (CREDENTIAL_WORDS.has(last)) return true;
  return CREDENTIAL_WORDS.has(words.slice(-2).join(""));
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isRedactedKey(key)) continue;
    out[key] = sanitizeUnknown(nested);
  }
  return out;
}

export function sanitizeUnknown(
  value: Record<string, unknown>,
): Record<string, unknown>;
export function sanitizeUnknown(value: unknown): unknown;
export function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (!isRecord(value)) return value;
  return sanitizeRecord(value);
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
    metadata: isRecord(raw.metadata) ? sanitizeUnknown(raw.metadata) : undefined,
    location,
    tokens: tokenUsageFrom(raw.tokens),
    cost: typeof raw.cost === "number" ? raw.cost : undefined,
    outcome,
  };
}

export function messageFrom(raw: unknown): OpenCodeSessionMessage | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    type: typeof raw.type === "string" ? raw.type : "unknown",
    text: typeof raw.text === "string" ? raw.text : undefined,
    agent: typeof raw.agent === "string" ? raw.agent : undefined,
    model: modelRefFrom(raw.model),
    skill: typeof raw.skill === "string" ? raw.skill : undefined,
    finish: typeof raw.finish === "string" ? raw.finish : undefined,
    tokens: tokenUsageFrom(raw.tokens),
    cost: typeof raw.cost === "number" ? raw.cost : undefined,
    content: sanitizeUnknown(raw.content),
  };
}
