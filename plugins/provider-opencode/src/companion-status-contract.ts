import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import {
  COMPANION_PACKAGE_NAME,
  COMPANION_PROTOCOL,
  COMPANION_REPOSITORY_URL,
  companionInstallCommand,
  companionInstallCommands,
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
    installCommands: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const companionProbeSchema = z
  .object({
    detected: z.boolean(),
    reason: z.string().nullable(),
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

const COMPANION_PLUGIN_IDS = new Set([
  COMPANION_PACKAGE_NAME,
  "bb.tools",
  COMPANION_PROTOCOL,
]);

export function protocolRangesOverlap(
  left: { min: number; max: number },
  right: { min: number; max: number },
): boolean {
  return left.max >= right.min && left.min <= right.max;
}

export function engineAppIdFrom(input: {
  explicitServerUrl: boolean;
  healthAppId: string | null;
  pathBinaryAppId: string | null;
  version: string | null;
  requestedApp: string | null;
}): string | null {
  if (!input.explicitServerUrl && input.healthAppId !== null) {
    return input.healthAppId;
  }
  if (
    input.requestedApp === "opencode" ||
    input.requestedApp === "shuvcode"
  ) {
    return input.requestedApp;
  }
  if (
    !input.explicitServerUrl &&
    (input.pathBinaryAppId === "opencode" ||
      input.pathBinaryAppId === "shuvcode")
  ) {
    return input.pathBinaryAppId;
  }
  if (input.version !== null && input.version.includes("-shuv")) {
    return "shuvcode";
  }
  return null;
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
    installCommands: [...companionInstallCommands(facts.appId)],
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

function undetected(
  facts: EngineFacts,
  reason: string,
  plugins: PluginListRead,
): CompanionProbe {
  const specs = plugins.kind === "ok" ? plugins.specs : [];
  return {
    detected: false,
    reason,
    package: { name: null, version: null },
    protocol: emptyProtocol(),
    install: { path: null, digest: null },
    instances: null,
    duplicates: specs.length > 1,
    pluginSpecs: specs,
    pluginListError: plugins.kind === "failed" ? plugins.message : null,
    richFailures: null,
    limits: null,
    engine: engineFrom(facts),
    repositoryUrl: COMPANION_REPOSITORY_URL,
  };
}

export function companionProbeFrom(input: {
  engine: EngineFacts;
  hello: HelloRead;
  plugins: PluginListRead;
}): CompanionProbe {
  if (input.hello.kind !== "ok") {
    return undetected(input.engine, input.hello.message, input.plugins);
  }
  const parsed = helloSchema.safeParse(input.hello.value);
  if (!parsed.success || parsed.data.protocol === undefined) {
    return undetected(
      input.engine,
      `OpenCode companion hello did not match ${COMPANION_PROTOCOL}. Install a compatible ${COMPANION_PACKAGE_NAME} release with the engine's plugin add command.`,
      input.plugins,
    );
  }
  if (parsed.data.protocol !== COMPANION_PROTOCOL) {
    return undetected(
      input.engine,
      `OpenCode companion protocol ${parsed.data.protocol} is not ${COMPANION_PROTOCOL}.`,
      input.plugins,
    );
  }
  const versions = parsed.data.versions ?? null;
  const legacyVersion = parsed.data.version ?? null;
  const overlapSource = versions ?? (
    legacyVersion === null
      ? null
      : { min: legacyVersion, max: legacyVersion }
  );
  const specs = input.plugins.kind === "ok" ? input.plugins.specs : [];
  const instances = parsed.data.instances ?? null;
  return {
    detected: true,
    reason: null,
    package: {
      name: nonEmpty(parsed.data.package?.name),
      version: nonEmpty(parsed.data.package?.version),
    },
    protocol: {
      name: parsed.data.protocol,
      versions,
      legacyVersion,
      overlapsSupported:
        overlapSource === null
          ? null
          : protocolRangesOverlap(overlapSource, SUPPORTED_PROTOCOL_RANGE),
      supported: SUPPORTED_PROTOCOL_RANGE,
    },
    install: {
      path: nonEmpty(parsed.data.install?.path),
      digest: nonEmpty(parsed.data.install?.digest),
    },
    instances,
    duplicates: (instances !== null && instances > 1) || specs.length > 1,
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

function isCompanionPlugin(id: string | null, spec: string): boolean {
  if (id !== null && COMPANION_PLUGIN_IDS.has(id)) return true;
  return spec.includes(COMPANION_PACKAGE_NAME);
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
    if (!isCompanionPlugin(id, spec)) continue;
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

export function formatCompanionStatus(status: CompanionStatus): string {
  const lines = [
    `Machine: ${status.machineId}`,
    status.detected
      ? `Companion: ${status.package.name ?? COMPANION_PACKAGE_NAME}${status.package.version === null ? "" : ` ${status.package.version}`}`
      : "Companion: not installed",
  ];
  if (status.reason !== null) lines.push(`Reason: ${status.reason}`);
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
  if (status.duplicates) {
    lines.push("Duplicates: remove every extra spec, then retry");
    for (const spec of status.pluginSpecs) {
      lines.push(`Spec: ${spec.spec}${spec.id === null ? "" : ` (${spec.id})`}`);
    }
  }
  if (status.richFailures !== null) {
    lines.push(`Rich failures: ${status.richFailures ? "yes" : "no"}`);
  }
  const engine = [status.engine.appId, status.engine.version]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (engine.length > 0) lines.push(`Engine: ${engine}`);
  if (status.engine.explicitServerUrl) lines.push("Engine mode: OPENCODE_SERVER_URL");
  for (const command of status.engine.installCommands) {
    lines.push(`Install: ${command}`);
  }
  lines.push(`Repository: ${status.repositoryUrl}`);
  lines.push(`bb tools required: ${status.bbToolsRequired ? "on" : "off"}`);
  if (!status.detected && status.bbToolsRequired) {
    lines.push("Turns fail until the companion is installed.");
  }
  return lines.join("\n");
}
