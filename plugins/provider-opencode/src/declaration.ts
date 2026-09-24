import type {
  PluginProviderDeclaration,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { opencodeExtensionKinds } from "./extension-kinds.js";
import { OPENCODE_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";
import { withBbToolsRequired } from "./bb-tools-required.js";
import {
  OPENCODE_EXPIRED_HINT,
  OPENCODE_INSTALL_URL,
  OPENCODE_SIGN_IN_HINT,
} from "./strings.js";

export const OPENCODE_PROVIDER_ID = "opencode";

export const OPENCODE_ENV_PASSTHROUGH = [
  "OPENCODE_SERVER_URL",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_APP",
] as const;

export type OpenCodeProviderOptions = {
  agent: string | null;
  variant: string | null;
  bbToolsRequired: boolean;
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
  return withBbToolsRequired(
    {
      agent: stringSetting(context.settings, "defaultAgent"),
      variant,
    },
    context.settings,
  );
}

export function opencodeProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: OPENCODE_PROVIDER_ID,
    displayName: "OpenCode v2",
    icon: "./icons/opencode.svg",
    strings: {
      signInHint: OPENCODE_SIGN_IN_HINT,
      expiredHint: OPENCODE_EXPIRED_HINT,
      installUrl: OPENCODE_INSTALL_URL,
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
    composerActions: [],
    deriveProviderOptions: deriveOpenCodeProviderOptions,
    extensionKinds: opencodeExtensionKinds,
  };
}
