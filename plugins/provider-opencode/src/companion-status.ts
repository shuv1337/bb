import {
  companionPluginSpecsFrom,
  companionProbeFrom,
  companionProbeSchema,
  engineAppIdFrom,
  type CompanionProbe,
  type EngineFacts,
  type HelloRead,
  type PluginListRead,
} from "./companion-status-contract.js";
import {
  callCompanionHello,
  companionRpcFailure,
  companionRpcMessage,
  listLocationPlugins,
  type LocationDirectory,
} from "./companion-location-rpc.js";
import { COMPANION_PROTOCOL } from "./companion-install.js";
import {
  discoveryDepsFrom,
  resolveAttachedRegistration,
} from "./runtime/discovery.js";
import { sanitizeErrorMessage } from "./runtime/errors.js";
import type { CreateOpenCodeRuntimeOptions } from "./runtime/types.js";

export type ReadCompanionStatusOptions = CreateOpenCodeRuntimeOptions & {
  location?: LocationDirectory;
};

function helloRead(error: unknown): HelloRead {
  const kind = companionRpcFailure(error);
  if (kind === "absent") {
    return {
      kind: "absent",
      message: `${COMPANION_PROTOCOL} is not installed (${companionRpcMessage(error)})`,
    };
  }
  return {
    kind: "failed",
    message: `OpenCode companion hello failed (${companionRpcMessage(error)})`,
  };
}

async function readPlugins(
  target: { url: string; password?: string; fetch?: typeof globalThis.fetch },
  location: LocationDirectory | undefined,
): Promise<PluginListRead> {
  try {
    return companionPluginSpecsFrom(await listLocationPlugins(target, location));
  } catch (error) {
    return {
      kind: "failed",
      message: `OpenCode plugin list failed (${companionRpcMessage(error)})`,
    };
  }
}

export async function readCompanionStatus(
  options: ReadCompanionStatusOptions = {},
): Promise<CompanionProbe> {
  const deps = discoveryDepsFrom(options);
  const attached = await resolveAttachedRegistration(deps);
  const requested = deps.env.OPENCODE_APP?.trim() ?? "";
  const facts: EngineFacts = {
    appId: engineAppIdFrom({
      explicitServerUrl: attached.explicit,
      healthAppId: attached.health.appId,
      pathBinaryAppId: attached.health.pathBinaryAppId,
      version: attached.health.version,
      requestedApp: requested.length === 0 ? null : requested,
    }),
    version: attached.health.version,
    explicitServerUrl: attached.explicit,
  };
  if (attached.health.status !== "ready" || attached.registration === null) {
    const detail = attached.health.statusMessage ?? attached.health.status;
    return companionProbeSchema.parse(
      companionProbeFrom({
        engine: facts,
        hello: {
          kind: "failed",
          message: `OpenCode is not ready (${sanitizeErrorMessage(detail)})`,
        },
        plugins: { kind: "ok", specs: [] },
      }),
    );
  }
  const target = {
    url: attached.registration.url,
    password: attached.registration.password,
    fetch: deps.fetch,
  };
  let hello: HelloRead;
  try {
    hello = { kind: "ok", value: await callCompanionHello(target, options.location) };
  } catch (error) {
    hello = helloRead(error);
  }
  const plugins = await readPlugins(target, options.location);
  return companionProbeSchema.parse(
    companionProbeFrom({ engine: facts, hello, plugins }),
  );
}
