import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import {
  companionInstallCommands,
  COMPANION_PACKAGE_NAME,
  COMPANION_REPOSITORY_URL,
} from "./companion-install.js";

export const BB_TOOLS_REQUIRED_SETTING = "bbToolsRequired";

export function bbToolsRequiredFromSettings(
  settings: PluginProviderOptionsContext["settings"],
): boolean {
  return settings[BB_TOOLS_REQUIRED_SETTING] === true;
}

export function withBbToolsRequired<T extends Record<string, unknown>>(
  options: T,
  settings: PluginProviderOptionsContext["settings"],
): T & { bbToolsRequired: boolean } {
  return {
    ...options,
    bbToolsRequired: bbToolsRequiredFromSettings(settings),
  };
}

export function bbToolsRequiredSetupMessage(appId: string | null): string {
  const command = companionInstallCommands(appId)
    .map((entry) => `\`${entry}\``)
    .join(" or ");
  return `bb tools are required on this host, and the ${COMPANION_PACKAGE_NAME} companion is not installed. Install it from ${COMPANION_REPOSITORY_URL} with ${command}, or turn off bb tools required, then retry the turn.`;
}
