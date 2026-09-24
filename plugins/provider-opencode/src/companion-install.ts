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

export function companionInstallCommand(appId: string | null): string | null {
  const cli = companionEngineAppId(appId);
  if (cli === null) return null;
  return `${cli} plugin add ${COMPANION_PACKAGE_NAME}`;
}

export function companionInstallCommands(
  appId: string | null,
): readonly string[] {
  const exact = companionInstallCommand(appId);
  if (exact !== null) return [exact];
  return ENGINE_APP_IDS.map(
    (cli) => `${cli} plugin add ${COMPANION_PACKAGE_NAME}`,
  );
}

export function companionPinnedGitSpecifier(tag: string): string {
  return `github:shuv1337/opencode-bb-tools#${tag}`;
}
