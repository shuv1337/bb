import type {
  PluginProviderDeclaration,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { OPENCODE_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";

export const OPENCODE_PROVIDER_ID = "opencode";

export const OPENCODE_ENV_PASSTHROUGH = [
  "BB_OPENCODE_SERVER",
  "BB_OPENCODE_PASSWORD",
  "BB_OPENCODE_APP",
] as const;

export type OpenCodeProviderOptions = {
  agent: string | null;
  variant: string | null;
};

function stringSetting(
  settings: PluginProviderOptionsContext["settings"],
  key: string,
): string | null {
  const raw = settings[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function deriveOpenCodeProviderOptions(
  context: PluginProviderOptionsContext,
): OpenCodeProviderOptions {
  const variant = stringSetting(context.settings, "defaultVariant");
  if (context.promptMode === "plan") {
    return { agent: "plan", variant };
  }
  return {
    agent: stringSetting(context.settings, "defaultAgent"),
    variant,
  };
}

export function opencodeProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: OPENCODE_PROVIDER_ID,
    displayName: "OpenCode",
    icon: "./icons/opencode.svg",
    experimental_visibility: "installed",
    strings: {
      signInHint: "Run `opencode auth login` on the machine to sign in.",
      expiredHint:
        "Your OpenCode session expired. Run `opencode auth login`, then reload.",
      installUrl: "https://opencode.ai/v2/docs/",
      planModeCopy: "OpenCode will switch to the plan agent.",
      iconTint: { light: "#2563EB", dark: "#2563EB" },
    },
    models: { scope: "workspace" },
    maintenance: { health: true, usage: false, installation: true },
    env: { passthrough: [...OPENCODE_ENV_PASSTHROUGH] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: true,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    ...OPENCODE_NATIVE_ROOTS_DECLARATION,
    composerActions: ["plan"],
    deriveProviderOptions: deriveOpenCodeProviderOptions,
  };
}
