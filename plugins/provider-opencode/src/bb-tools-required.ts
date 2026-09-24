import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import {
  companionInstallPlans,
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
  const plans = companionInstallPlans(appId);
  const command = plans
    .map((entry) =>
      plans.length === 1
        ? `\`${entry.command}\``
        : `\`${entry.command}\` (writes ${entry.writes})`,
    )
    .join(" or ");
  return `bb tools are required, and the ${COMPANION_PACKAGE_NAME} companion is not installed on this engine. Install it from ${COMPANION_REPOSITORY_URL} with ${command}, or turn off bb tools required, then retry the turn.`;
}
