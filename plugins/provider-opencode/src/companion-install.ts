export const COMPANION_PACKAGE_NAME = "opencode-bb-tools";
export const COMPANION_REPOSITORY_URL =
  "https://github.com/shuv1337/opencode-bb-tools";
export const COMPANION_PROTOCOL = "bb.tools.v1";
export const SUPPORTED_PROTOCOL_RANGE = { min: 1, max: 1 } as const;
export const COMPANION_CLIENT_NAME = "bb";
export const COMPANION_CLIENT_VERSION = "0.1.0";

const ENGINE_APP_IDS = ["opencode", "shuvcode"] as const;

export type CompanionEngineAppId = (typeof ENGINE_APP_IDS)[number];

export function companionEngineAppId(
  appId: string | null,
): CompanionEngineAppId | null {
  if (appId === "opencode" || appId === "shuvcode") return appId;
  return null;
}

export type CompanionInstallPlan = {
  command: string;
  writes: string;
};

const CONFIG_WRITES: Record<CompanionEngineAppId, string> = {
  opencode: "stock OpenCode config (~/.config/opencode), not Shuvcode's",
  shuvcode: "Shuvcode config (~/.config/shuvcode), not stock OpenCode's",
};

export function companionInstallPlans(
  appId: string | null,
): readonly CompanionInstallPlan[] {
  const exact = companionEngineAppId(appId);
  const ids: readonly CompanionEngineAppId[] =
    exact === null ? ENGINE_APP_IDS : [exact];
  return ids.map((cli) => ({
    command: `${cli} plugin add ${COMPANION_PACKAGE_NAME}`,
    writes: CONFIG_WRITES[cli],
  }));
}

export function companionInstallCommand(appId: string | null): string | null {
  const plans = companionInstallPlans(appId);
  const only = plans[0];
  return plans.length === 1 && only !== undefined ? only.command : null;
}

export function companionInstallCommands(
  appId: string | null,
): readonly string[] {
  return companionInstallPlans(appId).map((plan) => plan.command);
}

export function companionPinnedGitSpecifier(tag: string): string {
  return `github:shuv1337/opencode-bb-tools#${tag}`;
}
