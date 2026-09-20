import type {
  AvailableModel,
  ModelReasoningEffort,
  ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  OpenCodeModel,
  OpenCodeModelLimit,
  OpenCodeModelRef,
} from "./runtime/types.js";

const LADDER_EFFORTS: Readonly<Record<string, ModelReasoningEffort>> = {
  none: { reasoningEffort: "none", description: "No extended thinking" },
  low: { reasoningEffort: "low", description: "Low reasoning effort" },
  medium: { reasoningEffort: "medium", description: "Medium reasoning effort" },
  high: { reasoningEffort: "high", description: "High reasoning effort" },
  xhigh: {
    reasoningEffort: "xhigh",
    description: "Extra high reasoning effort",
  },
  ultracode: {
    reasoningEffort: "ultracode",
    description:
      "Extra high reasoning effort plus multi-agent workflow orchestration",
  },
  max: { reasoningEffort: "max", description: "Maximum reasoning effort" },
  ultra: {
    reasoningEffort: "ultra",
    description: "Maximum reasoning with automatic task delegation",
  },
};

const LADDER_IDS = new Set(Object.keys(LADDER_EFFORTS));

export function toWireModelId(model: {
  providerID: string;
  id: string;
}): string {
  return `${model.providerID}/${model.id}`;
}

export function parseWireModelId(wireId: string): OpenCodeModelRef | null {
  const slash = wireId.indexOf("/");
  if (slash <= 0 || slash === wireId.length - 1) return null;
  return {
    providerID: wireId.slice(0, slash),
    id: wireId.slice(slash + 1),
  };
}

export function toOpenCodeModel(input: {
  providerID: string;
  id: string;
  modelID?: string;
  name: string;
  variants?: readonly { id: string }[];
  enabled?: boolean;
  isDefault?: boolean;
  defaultVariant?: string;
  limit?: OpenCodeModelLimit;
}): OpenCodeModel {
  return {
    providerID: input.providerID,
    id: input.id,
    modelID: input.modelID ?? input.id,
    name: input.name,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? false,
    defaultVariant: input.defaultVariant,
    limit: input.limit,
    variants: (input.variants ?? []).map((variant) => ({
      id: variant.id,
      label: variant.id,
    })),
  };
}

export function toAvailableModel(model: OpenCodeModel): AvailableModel {
  const supportedReasoningEfforts = effortsForModel(model);
  return {
    id: toWireModelId(model),
    model: toWireModelId(model),
    displayName: model.name,
    description: describeModel(model),
    supportedReasoningEfforts,
    defaultReasoningEffort: defaultEffort(model, supportedReasoningEfforts),
    isDefault: model.isDefault,
  };
}

export function toAvailableModels(input: {
  models: readonly OpenCodeModel[];
  defaultModel?: { providerID: string; id: string; variant?: string } | null;
}): AvailableModel[] {
  const defaultWire =
    input.defaultModel === undefined || input.defaultModel === null
      ? null
      : toWireModelId(input.defaultModel);
  return input.models
    .filter((model) => model.enabled)
    .map((model) => {
      const isDefault = defaultWire !== null && toWireModelId(model) === defaultWire;
      return toAvailableModel({
        ...model,
        isDefault,
        defaultVariant: isDefault
          ? input.defaultModel?.variant ?? model.defaultVariant
          : model.defaultVariant,
      });
    });
}

function effortsForModel(model: OpenCodeModel): ModelReasoningEffort[] {
  const efforts: ModelReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const variant of model.variants) {
    if (!LADDER_IDS.has(variant.id) || seen.has(variant.id)) continue;
    seen.add(variant.id);
    const effort = LADDER_EFFORTS[variant.id];
    if (effort) efforts.push({ ...effort });
  }
  return efforts;
}

function defaultEffort(
  model: OpenCodeModel,
  efforts: readonly ModelReasoningEffort[],
): ReasoningLevel {
  const preferred = model.defaultVariant;
  if (
    preferred !== undefined &&
    efforts.some((effort) => effort.reasoningEffort === preferred)
  ) {
    return preferred as ReasoningLevel;
  }
  return efforts[0]?.reasoningEffort ?? "none";
}

function describeModel(model: OpenCodeModel): string {
  const extra = model.variants
    .map((variant) => variant.id)
    .filter((id) => !LADDER_IDS.has(id));
  if (extra.length === 0) {
    return `${model.providerID} ${model.name}`;
  }
  return `${model.providerID} ${model.name} (variants: ${extra.join(", ")})`;
}
