import { z } from "zod";
import type {
  BridgeExecutionOptions,
  InstructionMode,
  PromptInput,
  ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  buildShellEnvOverrides,
  isStandaloneBuiltinCompactCommand,
} from "@get-bb/plugin-sdk/provider-bridge";
import { parseWireModelId } from "./models.js";
import { sessionRulesForPermissionMode } from "./permissions.js";
import { OpenCodeInstructionReplaceError } from "./runtime/index.js";
import type {
  OpenCodeModel,
  OpenCodeModelRef,
  OpenCodePermissionMode,
  OpenCodePermissionRule,
  OpenCodePromptFile,
  OpenCodePromptInput,
  OpenCodePromptSkill,
} from "./runtime/index.js";
import { extractOpenCodeTurnInput } from "./bridge/turn-input.js";

const providerOptionsSchema = z
  .object({
    agent: z.string().min(1).nullable().optional(),
    persistApprovals: z.boolean().optional(),
    variant: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export type OpenCodeProviderOptions = {
  agent: string | null;
  persistApprovals: boolean;
  variant: string | null;
};

export class OpenCodeUnknownVariantError extends Error {
  constructor(variant: string, modelId: string) {
    super(`OpenCode model ${modelId} has no variant "${variant}"`);
    this.name = "OpenCodeUnknownVariantError";
  }
}

export function parseOpenCodeProviderOptions(
  value: Record<string, unknown> | undefined,
): OpenCodeProviderOptions {
  const parsed = providerOptionsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return { agent: null, persistApprovals: false, variant: null };
  }
  return {
    agent: parsed.data.agent === undefined ? null : parsed.data.agent,
    persistApprovals: parsed.data.persistApprovals === true,
    variant:
      parsed.data.variant === undefined || parsed.data.variant === null
        ? null
        : parsed.data.variant,
  };
}

export function assertOpenCodeInstructionMode(mode: InstructionMode): void {
  if (mode === "replace") {
    throw new OpenCodeInstructionReplaceError();
  }
}

export function resolveOpenCodeModelRef(args: {
  wireId: string | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  configuredVariant: string | null;
  catalog: readonly OpenCodeModel[];
}): OpenCodeModelRef | undefined {
  if (args.wireId === undefined || args.wireId.length === 0) {
    return undefined;
  }
  const parsed = parseWireModelId(args.wireId);
  if (parsed === null) {
    return undefined;
  }
  const model = args.catalog.find(
    (entry) => entry.providerID === parsed.providerID && entry.id === parsed.id,
  );
  const variantIds = new Set((model?.variants ?? []).map((variant) => variant.id));
  const reasoning = args.reasoningLevel;
  const applicableReasoning =
    reasoning !== undefined &&
    reasoning !== "none" &&
    variantIds.has(reasoning)
      ? reasoning
      : undefined;
  if (applicableReasoning !== undefined) {
    return { ...parsed, variant: applicableReasoning };
  }
  if (args.configuredVariant !== null && args.configuredVariant.length > 0) {
    if (!variantIds.has(args.configuredVariant)) {
      throw new OpenCodeUnknownVariantError(args.configuredVariant, args.wireId);
    }
    return { ...parsed, variant: args.configuredVariant };
  }
  return parsed;
}

export function mapApprovalToOpenCodeReply(args: {
  decision: "allow_once" | "allow_for_session" | "deny";
  persistApprovals: boolean;
}): "once" | "always" | "reject" {
  if (args.decision === "deny") {
    return "reject";
  }
  if (args.decision === "allow_once") {
    return "once";
  }
  return args.persistApprovals ? "always" : "once";
}

export function buildOpenCodeShellEnv(args: {
  threadId: string;
  envVars: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    BB_THREAD_ID: args.threadId,
    ...buildShellEnvOverrides(args.envVars),
  };
}

export type OpenCodeTurnKind =
  | { kind: "compact" }
  | { kind: "command"; name: string; text: string }
  | { kind: "prompt"; prompt: OpenCodePromptInput };

export function classifyOpenCodeTurn(args: {
  input: PromptInput[];
  clientRequestId: string;
  delivery: "steer" | "queue";
}): OpenCodeTurnKind {
  if (isStandaloneBuiltinCompactCommand(args.input)) {
    return { kind: "compact" };
  }
  const extracted = extractOpenCodeTurnInput(args.input);
  const id = promptMessageId(args.clientRequestId);
  if (extracted.command !== null) {
    return {
      kind: "command",
      name: extracted.command.name,
      text: extracted.command.text,
    };
  }
  const skills: OpenCodePromptSkill[] = extracted.skills.map((skill) => ({
    id: skill.id,
  }));
  const files: OpenCodePromptFile[] = extracted.files;
  return {
    kind: "prompt",
    prompt: {
      text: extracted.text,
      ...(files.length > 0 ? { files } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      delivery: args.delivery,
      id,
    },
  };
}

export function promptMessageId(clientRequestId: string): string {
  return clientRequestId.startsWith("msg_")
    ? clientRequestId
    : `msg_${clientRequestId}`;
}

export function sessionTitleForThread(threadId: string): string {
  return `bb: ${threadId}`;
}

export interface AppliedSessionKnobs {
  agent: string | null;
  model: OpenCodeModelRef | undefined;
  permissionMode: OpenCodePermissionMode;
  permissions: OpenCodePermissionRule[];
  env: Record<string, string>;
  persistApprovals: boolean;
  instructions: { mode: "append"; text: string } | null;
}

export function knobsFromExecution(args: {
  threadId: string;
  options: BridgeExecutionOptions;
  instructionMode: InstructionMode;
  catalog: readonly OpenCodeModel[];
}): AppliedSessionKnobs {
  assertOpenCodeInstructionMode(args.instructionMode);
  const providerOptions = parseOpenCodeProviderOptions(
    args.options.providerOptions as Record<string, unknown> | undefined,
  );
  const trimmed = args.options.instructions?.trim();
  return {
    agent: providerOptions.agent,
    model: resolveOpenCodeModelRef({
      wireId: args.options.model,
      reasoningLevel: args.options.reasoningLevel,
      configuredVariant: providerOptions.variant,
      catalog: args.catalog,
    }),
    permissionMode: args.options.permissionMode,
    permissions: sessionRulesForPermissionMode(args.options.permissionMode),
    env: buildOpenCodeShellEnv({
      threadId: args.threadId,
      envVars: args.options.envVars,
    }),
    persistApprovals: providerOptions.persistApprovals,
    instructions:
      trimmed === undefined || trimmed.length === 0
        ? null
        : { mode: "append", text: trimmed },
  };
}
