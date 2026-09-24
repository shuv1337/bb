import {
  companionInstallCommands,
  COMPANION_PACKAGE_NAME,
  COMPANION_REPOSITORY_URL,
} from "./companion-install.js";

export const OPENCODE_SIGN_IN_HINT =
  "Run `shuvcode auth login` on the machine to sign in, or `opencode auth login` for upstream OpenCode.";

export const OPENCODE_EXPIRED_HINT =
  "Your OpenCode session expired. Run `shuvcode auth login`, or `opencode auth login` for upstream OpenCode, then reload.";

export const OPENCODE_INSTALL_URL = "https://www.npmjs.com/package/shuvcode";

export const ABSENT_COMPANION_WARNING_SUMMARY =
  "OpenCode does not run bb plugin tools";

export function absentCompanionWarningDetails(input: {
  toolNames: readonly string[];
  appId: string | null;
}): string {
  const names = input.toolNames.join(", ");
  const command = companionInstallCommands(input.appId)
    .map((entry) => `\`${entry}\``)
    .join(" or ");
  return `Dropped dynamicTools: ${names} (${COMPANION_PACKAGE_NAME} is not installed). Install the bb tools companion from ${COMPANION_REPOSITORY_URL} with ${command}.`;
}
