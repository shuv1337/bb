import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import {
  COMPANION_PACKAGE_NAME,
  COMPANION_PROTOCOL,
  COMPANION_REPOSITORY_URL,
  companionInstallCommand,
  companionInstallPlans,
  SUPPORTED_PROTOCOL_RANGE,
} from "./companion-install.js";

const protocolRangeSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
  })
  .strict();

export const companionLimitsSchema = z
  .object({
    maxOutstandingCalls: z.number().int().nonnegative(),
    maxResultBytes: z.number().int().nonnegative(),
    maxToolsPerBinding: z.number().int().nonnegative(),
    ownerLeaseMs: z.number().int().positive(),
    maxPendingWaitMs: z.number().int().nonnegative(),
  })
  .strict();

export const companionPluginSpecSchema = z
  .object({
    id: z.string().nullable(),
    source: z.enum(["package", "local", "builtin", "sdk", "unknown"]),
    spec: z.string().min(1),
    state: z.enum(["active", "failed"]),
    error: z.string().nullable(),
  })
  .strict();

const companionEngineSchema = z
  .object({
    appId: z.string().nullable(),
    version: z.string().nullable(),
    explicitServerUrl: z.boolean(),
    installCommand: z.string().nullable(),
    installCommands: z
      .array(
        z
          .object({
            command: z.string().min(1),
            writes: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const companionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z
    .object({
      status: z.literal("unreachable"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("incompatible"),
      message: z.string().min(1),
      details: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("ready") }).strict(),
]);

export const companionProbeSchema = z
  .object({
    state: companionStateSchema,
    package: z
      .object({
        name: z.string().nullable(),
        version: z.string().nullable(),
      })
      .strict(),
    protocol: z
      .object({
        name: z.string().nullable(),
        versions: protocolRangeSchema.nullable(),
        legacyVersion: z.number().int().nullable(),
        overlapsSupported: z.boolean().nullable(),
        supported: z
          .object({
            min: z.literal(SUPPORTED_PROTOCOL_RANGE.min),
            max: z.literal(SUPPORTED_PROTOCOL_RANGE.max),
          })
          .strict(),
      })
      .strict(),
    install: z
      .object({
        path: z.string().nullable(),
        digest: z.string().nullable(),
      })
      .strict(),
    instances: z.number().int().nonnegative().nullable(),
    duplicates: z.boolean(),
    pluginSpecs: z.array(companionPluginSpecSchema),
    pluginListError: z.string().nullable(),
    richFailures: z.boolean().nullable(),
    limits: companionLimitsSchema.nullable(),
    engine: companionEngineSchema,
    repositoryUrl: z.literal(COMPANION_REPOSITORY_URL),
  })
  .strict();

export const companionStatusSchema = companionProbeSchema
  .extend({
    machineId: z.string().min(1),
    bbToolsRequired: z.boolean(),
  })
  .strict();

export type CompanionProbe = z.infer<typeof companionProbeSchema>;
export type CompanionStatus = z.infer<typeof companionStatusSchema>;
export type CompanionPluginSpec = z.infer<typeof companionPluginSpecSchema>;
export type CompanionState = z.infer<typeof companionStateSchema>;

export const openCodeHostContract = defineRpcContract({
  resolveNativeRoots: experimental_nativeRootsHostContract.resolveNativeRoots,
  readCompanionStatus: {
    input: z.object({}).strict(),
    output: companionProbeSchema,
  },
});

export const opencodeToolsRpcContract = defineRpcContract({
  companionStatus: {
    experimental_description:
      "Read-only bb tools companion status for one machine",
    input: z.object({ machineId: z.string().min(1) }).strict(),
    output: companionStatusSchema,
  },
});

const helloVersionsSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
  })
  .strict();

const helloSchema = z
  .object({
    protocol: z.string().optional(),
    versions: helloVersionsSchema.optional(),
    version: z.number().int().optional(),
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
    instances: z.number().int().nonnegative().optional(),
    features: z
      .object({
        richFailures: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type HelloRead =
  | { kind: "absent"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "unrecognized"; message: string }
  | { kind: "ok"; value: unknown };

export type PluginListRead =
  | { kind: "ok"; specs: CompanionPluginSpec[] }
  | { kind: "failed"; message: string };

export type EngineFacts = {
  appId: string | null;
  version: string | null;
  explicitServerUrl: boolean;
};

const COMPANION_GIT_REPO = "shuv1337/opencode-bb-tools";

export function isCompanionRegistrationSpec(spec: string): boolean {
  if (spec === COMPANION_PACKAGE_NAME) return true;
  const pin = `${COMPANION_PACKAGE_NAME}@`;
  if (spec.startsWith(pin)) {
    const version = spec.slice(pin.length);
    return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(version);
  }
  const github = new RegExp(
    `^github:${COMPANION_GIT_REPO}(?:\\.git)?(?:[?#].*)?$`,
    "u",
  );
  const https = new RegExp(
    `^(?:git\\+)?https://github\\.com/${COMPANION_GIT_REPO}(?:\\.git)?(?:[?#].*)?$`,
    "u",
  );
  const gitHttps = new RegExp(
    `^git:https://github\\.com/${COMPANION_GIT_REPO}(?:\\.git)?(?:[?#].*)?$`,
    "u",
  );
  return github.test(spec) || https.test(spec) || gitHttps.test(spec);
}

export function protocolRangesOverlap(
  left: { min: number; max: number },
  right: { min: number; max: number },
): boolean {
  return left.max >= right.min && left.min <= right.max;
}

function knownEngineAppId(value: string | null): "opencode" | "shuvcode" | null {
  if (value === "opencode" || value === "shuvcode") return value;
  return null;
}

export function engineAppIdFrom(input: {
  explicitServerUrl: boolean;
  healthAppId: string | null;
  pathBinaryAppId: string | null;
  version: string | null;
}): string | null {
  if (!input.explicitServerUrl && input.healthAppId !== null) {
    return input.healthAppId;
  }
  const reported = knownEngineAppId(input.healthAppId);
  if (reported !== null) return reported;
  if (input.version !== null && input.version.includes("-shuv")) {
    return "shuvcode";
  }
  if (input.explicitServerUrl) return null;
  return knownEngineAppId(input.pathBinaryAppId);
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function limitsFrom(value: unknown): CompanionProbe["limits"] {
  const parsed = companionLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function engineFrom(facts: EngineFacts): CompanionProbe["engine"] {
  return {
    appId: facts.appId,
    version: facts.version,
    explicitServerUrl: facts.explicitServerUrl,
    installCommand: companionInstallCommand(facts.appId),
    installCommands: [...companionInstallPlans(facts.appId)],
  };
}

function emptyProtocol(): CompanionProbe["protocol"] {
  return {
    name: null,
    versions: null,
    legacyVersion: null,
    overlapsSupported: null,
    supported: SUPPORTED_PROTOCOL_RANGE,
  };
}

function messageOr(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function reliableSpecs(specs: readonly CompanionPluginSpec[]): CompanionPluginSpec[] {
  return specs.filter((spec) => isCompanionRegistrationSpec(spec.spec));
}

function duplicatesFrom(
  instances: number | null,
  specs: readonly CompanionPluginSpec[],
): boolean {
  if (instances !== null) return instances > 1;
  return specs.filter((spec) => spec.state === "active").length > 1;
}

function shellProbe(
  facts: EngineFacts,
  plugins: PluginListRead,
  state: CompanionState,
): CompanionProbe {
  const specs = reliableSpecs(plugins.kind === "ok" ? plugins.specs : []);
  return {
    state,
    package: { name: null, version: null },
    protocol: emptyProtocol(),
    install: { path: null, digest: null },
    instances: null,
    duplicates: duplicatesFrom(null, specs),
    pluginSpecs: specs,
    pluginListError: plugins.kind === "failed" ? plugins.message : null,
    richFailures: null,
    limits: null,
    engine: engineFrom(facts),
    repositoryUrl: COMPANION_REPOSITORY_URL,
  };
}

function incompatibleHello(
  facts: EngineFacts,
  plugins: PluginListRead,
  message: string,
  details: string,
): CompanionProbe {
  return shellProbe(facts, plugins, {
    status: "incompatible",
    message,
    details: messageOr(details, message),
  });
}

export function companionProbeFrom(input: {
  engine: EngineFacts;
  hello: HelloRead;
  plugins: PluginListRead;
}): CompanionProbe {
  if (input.hello.kind === "absent") {
    return shellProbe(input.engine, input.plugins, { status: "absent" });
  }
  if (input.hello.kind === "failed") {
    return shellProbe(input.engine, input.plugins, {
      status: "unreachable",
      message: messageOr(
        input.hello.message,
        "OpenCode companion hello failed",
      ),
    });
  }
  if (input.hello.kind === "unrecognized") {
    return incompatibleHello(
      input.engine,
      input.plugins,
      `OpenCode companion hello did not match ${COMPANION_PROTOCOL}.`,
      input.hello.message,
    );
  }
  const parsed = helloSchema.safeParse(input.hello.value);
  if (!parsed.success || parsed.data.protocol === undefined) {
    return incompatibleHello(
      input.engine,
      input.plugins,
      `OpenCode companion hello did not match ${COMPANION_PROTOCOL}.`,
      parsed.success ? "missing protocol" : "malformed hello",
    );
  }
  if (parsed.data.protocol !== COMPANION_PROTOCOL) {
    return incompatibleHello(
      input.engine,
      input.plugins,
      `OpenCode companion protocol ${parsed.data.protocol} is not ${COMPANION_PROTOCOL}.`,
      `reported ${parsed.data.protocol}; supported ${COMPANION_PROTOCOL}`,
    );
  }
  const versions = parsed.data.versions ?? null;
  const legacyVersion = parsed.data.version ?? null;
  const overlapSource = versions ?? (
    legacyVersion === null
      ? null
      : { min: legacyVersion, max: legacyVersion }
  );
  const overlapsSupported =
    overlapSource === null
      ? null
      : protocolRangesOverlap(overlapSource, SUPPORTED_PROTOCOL_RANGE);
  const specs = reliableSpecs(
    input.plugins.kind === "ok" ? input.plugins.specs : [],
  );
  const instances = parsed.data.instances ?? null;
  const rangeMismatch =
    overlapsSupported === false
      ? versions !== null
        ? {
            message: `OpenCode companion protocol range ${versions.min}-${versions.max} does not overlap supported ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}.`,
            details: `reported ${versions.min}-${versions.max}; supported ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}`,
          }
        : {
            message: `OpenCode companion protocol version ${legacyVersion} does not overlap supported ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}.`,
            details: `reported version ${legacyVersion}; supported ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}`,
          }
      : null;
  return {
    state:
      rangeMismatch === null
        ? { status: "ready" }
        : {
            status: "incompatible",
            message: rangeMismatch.message,
            details: rangeMismatch.details,
          },
    package: {
      name: nonEmpty(parsed.data.package?.name),
      version: nonEmpty(parsed.data.package?.version),
    },
    protocol: {
      name: parsed.data.protocol,
      versions,
      legacyVersion,
      overlapsSupported,
      supported: SUPPORTED_PROTOCOL_RANGE,
    },
    install: {
      path: nonEmpty(parsed.data.install?.path),
      digest: nonEmpty(parsed.data.install?.digest),
    },
    instances,
    duplicates: duplicatesFrom(instances, specs),
    pluginSpecs: specs,
    pluginListError:
      input.plugins.kind === "failed" ? input.plugins.message : null,
    richFailures: parsed.data.features?.richFailures ?? null,
    limits: limitsFrom(parsed.data.limits),
    engine: engineFrom(input.engine),
    repositoryUrl: COMPANION_REPOSITORY_URL,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) next[key] = entry;
  return next;
}

function pluginArray(value: unknown): unknown[] | null {
  const body = record(value);
  const data = body?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(value)) return value;
  return null;
}

export function companionPluginSpecsFrom(value: unknown): PluginListRead {
  const items = pluginArray(value);
  if (items === null) {
    return { kind: "failed", message: "OpenCode plugin list was not an array" };
  }
  const specs: CompanionPluginSpec[] = [];
  for (const item of items) {
    const entry = record(item);
    if (entry === null) continue;
    const id = typeof entry.id === "string" ? entry.id : null;
    const source = record(entry.source);
    const sourceType = typeof source?.type === "string" ? source.type : "unknown";
    const spec =
      sourceType === "package" && typeof source?.target === "string"
        ? source.target
        : sourceType === "local" && typeof source?.path === "string"
          ? source.path
          : sourceType;
    if (!isCompanionRegistrationSpec(spec)) continue;
    const state = record(entry.state);
    const status = state?.status === "failed" ? "failed" : "active";
    const error =
      status === "failed" && typeof state?.error === "string"
        ? state.error
        : null;
    const parsed = companionPluginSpecSchema.safeParse({
      id,
      source:
        sourceType === "package" ||
        sourceType === "local" ||
        sourceType === "builtin" ||
        sourceType === "sdk"
          ? sourceType
          : "unknown",
      spec,
      state: status,
      error,
    });
    if (parsed.success) specs.push(parsed.data);
  }
  return { kind: "ok", specs };
}

function companionHeadline(status: CompanionStatus): string {
  if (status.state.status === "absent") return "Companion: not installed";
  if (status.state.status === "unreachable") return "Companion: unreachable";
  if (status.state.status === "incompatible") return "Companion: incompatible";
  const name = status.package.name ?? COMPANION_PACKAGE_NAME;
  const version =
    status.package.version === null ? "" : ` ${status.package.version}`;
  return `Companion: ${name}${version}`;
}

export function formatCompanionStatus(status: CompanionStatus): string {
  const lines = [`Machine: ${status.machineId}`, companionHeadline(status)];
  if (status.state.status === "unreachable") {
    lines.push(status.state.message);
  }
  if (status.state.status === "incompatible") {
    lines.push(status.state.message);
    if (status.state.details !== status.state.message) {
      lines.push(status.state.details);
    }
  }
  const protocol = status.protocol.versions;
  if (protocol !== null) {
    const overlap =
      status.protocol.overlapsSupported === null
        ? "unknown"
        : status.protocol.overlapsSupported
          ? "supported"
          : "unsupported";
    lines.push(`Protocol: ${protocol.min}-${protocol.max} (${overlap})`);
  } else if (status.protocol.legacyVersion !== null) {
    lines.push(
      `Protocol: version ${status.protocol.legacyVersion} (${status.protocol.overlapsSupported === false ? "unsupported" : "supported"}; range unknown)`,
    );
  }
  if (status.install.path !== null) lines.push(`Install path: ${status.install.path}`);
  if (status.install.digest !== null) lines.push(`Digest: ${status.install.digest}`);
  if (status.instances !== null) lines.push(`Instances: ${status.instances}`);
  const activeSpecs = status.pluginSpecs.filter((spec) => spec.state === "active");
  const failedSpecs = status.pluginSpecs.filter((spec) => spec.state === "failed");
  if (status.duplicates) {
    lines.push("Duplicates: remove every extra spec, then retry");
    for (const spec of activeSpecs) {
      lines.push(`Spec: ${spec.spec}${spec.id === null ? "" : ` (${spec.id})`}`);
    }
  }
  for (const spec of failedSpecs) {
    const error = spec.error === null ? "" : ` (${spec.error})`;
    lines.push(`Failed registration: ${spec.spec}${error}`);
  }
  if (status.richFailures !== null) {
    lines.push(`Rich failures: ${status.richFailures ? "yes" : "no"}`);
  }
  const engine = [status.engine.appId, status.engine.version]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (engine.length > 0) lines.push(`Engine: ${engine}`);
  if (status.engine.explicitServerUrl) lines.push("Engine mode: OPENCODE_SERVER_URL");
  if (status.state.status === "absent") {
    const uncertain = status.engine.installCommand === null;
    for (const plan of status.engine.installCommands) {
      lines.push(`Install: ${plan.command}`);
      if (uncertain) lines.push(`Config: ${plan.writes}`);
    }
  }
  lines.push(`Repository: ${status.repositoryUrl}`);
  lines.push(
    `bb tools required: ${status.bbToolsRequired ? "on" : "off"} (global setting, every machine)`,
  );
  if (status.state.status === "absent" && status.bbToolsRequired) {
    lines.push("Turns fail until the companion is installed.");
  }
  if (status.state.status === "incompatible") {
    lines.push("Turns fail until the companion is compatible.");
  }
  return lines.join("\n");
}
