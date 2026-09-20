import type { OpenCodeAgent } from "./types.js";

export function isSelectableAgent(agent: OpenCodeAgent): boolean {
  return !agent.hidden && (agent.mode === "primary" || agent.mode === "all");
}

export function extractConfigDefaultAgent(
  entries: readonly unknown[],
): string | null {
  let found: string | null = null;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "document") continue;
    const info = entry.info;
    if (!isRecord(info)) continue;
    if (typeof info.default_agent === "string" && info.default_agent.length > 0) {
      found = info.default_agent;
    }
  }
  return found;
}

export function resolveDefaultAgentId(input: {
  agents: readonly OpenCodeAgent[];
  configDefaultAgent: string | null;
}): string | null {
  const selectable = input.agents.filter(isSelectableAgent);
  if (
    input.configDefaultAgent !== null &&
    selectable.some((agent) => agent.id === input.configDefaultAgent)
  ) {
    return input.configDefaultAgent;
  }
  if (selectable.some((agent) => agent.id === "build")) return "build";
  return selectable[0]?.id ?? null;
}

export function resolvePlanExitAgentId(input: {
  settingDefaultAgent: string | null;
  agents: readonly OpenCodeAgent[];
  configDefaultAgent: string | null;
}): string | null {
  const selectable = input.agents.filter(isSelectableAgent);
  if (
    input.settingDefaultAgent !== null &&
    selectable.some((agent) => agent.id === input.settingDefaultAgent)
  ) {
    return input.settingDefaultAgent;
  }
  return resolveDefaultAgentId({
    agents: input.agents,
    configDefaultAgent: input.configDefaultAgent,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
