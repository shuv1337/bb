import { OpenCode } from "@opencode/client/promise";
import { Service } from "@opencode/client/service";
import {
  COMPANION_CLIENT_NAME,
  COMPANION_CLIENT_VERSION,
  COMPANION_PROTOCOL,
  SUPPORTED_PROTOCOL_RANGE,
} from "./companion-install.js";
import { sanitizeErrorMessage } from "./runtime/errors.js";
import type { OpenCodeJsonValue } from "./runtime/types.js";

export type LocationRpcTarget = {
  url: string;
  password?: string;
  fetch?: typeof globalThis.fetch;
};

export type LocationDirectory = {
  directory: string;
};

const HELLO_INPUT = {
  client: {
    name: COMPANION_CLIENT_NAME,
    version: COMPANION_CLIENT_VERSION,
  },
  protocol: SUPPORTED_PROTOCOL_RANGE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

export function companionRpcFailure(error: unknown): "absent" | "invalid" | "failed" {
  for (const value of causeChain(error)) {
    if (!isRecord(value)) continue;
    if (value.type === "rpc.unavailable") return "absent";
    if (value.type === "rpc.invalid_input") return "invalid";
    if (
      typeof value.message === "string" &&
      value.message === `RPC is unavailable: ${COMPANION_PROTOCOL}`
    ) {
      return "absent";
    }
  }
  return "failed";
}

export function companionRpcMessage(error: unknown): string {
  for (const value of causeChain(error)) {
    if (!isRecord(value)) continue;
    if (typeof value.message === "string" && value.message.length > 0) {
      return sanitizeErrorMessage(value.message);
    }
  }
  return error instanceof Error
    ? sanitizeErrorMessage(error.message)
    : "OpenCode companion request failed";
}

function fetchRejectingUnauthorized(
  fetchImpl: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 401) return response;
    const cause: Record<string, unknown> = { status: response.status };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        const payload: unknown = await response.json();
        if (isRecord(payload) && typeof payload.message === "string") {
          cause.message = payload.message;
        }
      } catch {
        await response.body?.cancel()?.catch(() => undefined);
      }
    } else {
      await response.body?.cancel()?.catch(() => undefined);
    }
    throw new Error("OpenCode rejected authentication", { cause });
  };
}

function clientFor(target: LocationRpcTarget) {
  return OpenCode.make({
    baseUrl: target.url,
    headers: Service.headers({
      url: target.url,
      auth:
        target.password === undefined
          ? undefined
          : {
              type: "basic",
              username: "opencode",
              password: target.password,
            },
    }),
    fetch: fetchRejectingUnauthorized(target.fetch ?? globalThis.fetch),
  });
}

export async function callLocationRpc(
  target: LocationRpcTarget,
  method: string,
  input: OpenCodeJsonValue,
  location?: LocationDirectory,
): Promise<unknown> {
  const client = clientFor(target);
  const response = await client.rpc.call({
    rpcID: COMPANION_PROTOCOL,
    method,
    input,
    ...(location === undefined ? {} : { location }),
  });
  return response.output;
}

export async function listLocationPlugins(
  target: LocationRpcTarget,
  location?: LocationDirectory,
): Promise<unknown> {
  const client = clientFor(target);
  return client.plugin.list(location === undefined ? undefined : { location });
}

export async function callCompanionHello(
  target: LocationRpcTarget,
  location?: LocationDirectory,
): Promise<unknown> {
  try {
    return await callLocationRpc(target, "hello", HELLO_INPUT, location);
  } catch (error) {
    if (companionRpcFailure(error) !== "invalid") throw error;
  }
  return callLocationRpc(target, "hello", {}, location);
}
