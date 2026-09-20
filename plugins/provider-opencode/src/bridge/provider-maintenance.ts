import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_resolveExecutablePath as resolveExecutablePath,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  discoveryDepsFrom,
  resolveAttachedRegistration,
} from "../runtime/discovery.js";
import type { OpenCodeDiscoveryHealth } from "../runtime/index.js";

export const OPENCODE_MINIMUM_SUPPORTED_VERSION = "2.0.0";
export const OPENCODE_NPM_PACKAGE = "@opencode/cli";
export const SHUVCODE_NPM_PACKAGE = "shuvcode";
export const OPENCODE_INSTALL_SCRIPT_URL = "https://opencode.ai/v2/install";
export const KNOWN_OPENCODE_APPS = ["opencode", "shuvcode"] as const;
export const WINDOWS_OPENCODE_INSTALL_MESSAGE =
  "OpenCode does not support Windows package managers. Download the Windows CLI from https://opencode.ai/v2/docs/";

export type KnownOpenCodeAppId = (typeof KNOWN_OPENCODE_APPS)[number];

export type OpenCodeMaintenanceDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  health?: () => Promise<OpenCodeDiscoveryHealth>;
  resolveExecutablePath?: typeof resolveExecutablePath;
  npmLatestVersion?: typeof npmLatestVersion;
  probeNpmGlobalPackage?: typeof probeNpmGlobalPackage;
};

function envOf(deps: OpenCodeMaintenanceDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

function platformOf(deps: OpenCodeMaintenanceDeps): NodeJS.Platform {
  return deps.platform ?? process.platform;
}

export function isKnownOpenCodeAppId(
  value: string | null,
): value is KnownOpenCodeAppId {
  return value === "opencode" || value === "shuvcode";
}

export function presentOpenCodeAppId(
  health: Pick<OpenCodeDiscoveryHealth, "appId" | "pathBinaryAppId">,
): string | null {
  const branded = health.pathBinaryAppId?.trim();
  if (branded) return branded;
  const registered = health.appId?.trim();
  if (registered) return registered;
  return null;
}

export function chosenOpenCodeAppId(
  env: Readonly<Record<string, string | undefined>>,
  health?: Pick<OpenCodeDiscoveryHealth, "appId" | "pathBinaryAppId">,
): string {
  const requested = env.BB_OPENCODE_APP?.trim() ?? "";
  const present = health === undefined ? null : presentOpenCodeAppId(health);
  if (present !== null) return present;
  if (requested.length > 0) return requested;
  return "opencode";
}

export function unsupportedOpenCodeForkMessage(appId: string): string {
  return `bb does not install "${appId}". Start it with \`${appId} serve --service\` or set BB_OPENCODE_SERVER to that service. Never replace a fork with upstream OpenCode.`;
}

export function replacePresentAppMessage(
  present: string,
  requested: string,
): string {
  return `bb will not replace "${present}" with "${requested}". Start \`${present} serve --service\` or set BB_OPENCODE_APP=${present}.`;
}

export function startServiceMessage(appId: string): string {
  return `run \`${appId} serve --service\` or open the ${appId} TUI`;
}

export function openCodeInstallCommand(
  appId: string,
  platform: NodeJS.Platform = process.platform,
): ProviderInstallationCommand | null {
  if (appId === "opencode") {
    if (platform === "win32") return null;
    return downloadedInstallerCommand(OPENCODE_INSTALL_SCRIPT_URL);
  }
  if (appId === "shuvcode") {
    return npmGlobalInstallCommand(SHUVCODE_NPM_PACKAGE);
  }
  return null;
}

function npmPackageForApp(appId: string): string | null {
  if (appId === "opencode") return OPENCODE_NPM_PACKAGE;
  if (appId === "shuvcode") return SHUVCODE_NPM_PACKAGE;
  return null;
}

async function defaultHealth(
  deps: OpenCodeMaintenanceDeps,
): Promise<OpenCodeDiscoveryHealth> {
  const attached = await resolveAttachedRegistration(
    discoveryDepsFrom({
      env: envOf(deps),
      homedir: deps.homedir,
    }),
  );
  return attached.health;
}

async function readHealth(
  deps: OpenCodeMaintenanceDeps,
): Promise<OpenCodeDiscoveryHealth> {
  return deps.health ? deps.health() : defaultHealth(deps);
}

function loginCommandFor(health: OpenCodeDiscoveryHealth): string {
  return `${presentOpenCodeAppId(health) ?? "opencode"} auth login`;
}

function shouldOfferInstall(health: OpenCodeDiscoveryHealth): boolean {
  return (
    health.status === "not_installed" || health.status === "unsupported_version"
  );
}

function forkBlocksInstall(health: OpenCodeDiscoveryHealth): string | null {
  const branded = health.pathBinaryAppId;
  if (branded !== null && !isKnownOpenCodeAppId(branded)) {
    return unsupportedOpenCodeForkMessage(branded);
  }
  return null;
}

function installBlockMessage(
  health: OpenCodeDiscoveryHealth,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string | null {
  const forkMessage = forkBlocksInstall(health);
  if (forkMessage !== null) return forkMessage;
  if (!shouldOfferInstall(health)) return null;
  const installApp = chosenOpenCodeAppId(env, health);
  const requested = env.BB_OPENCODE_APP?.trim() ?? "";
  const present = presentOpenCodeAppId(health);
  if (
    present !== null &&
    requested.length > 0 &&
    requested !== present
  ) {
    return replacePresentAppMessage(present, requested);
  }
  if (!isKnownOpenCodeAppId(installApp)) {
    return unsupportedOpenCodeForkMessage(installApp);
  }
  if (installApp === "opencode" && platform === "win32") {
    return WINDOWS_OPENCODE_INSTALL_MESSAGE;
  }
  if (openCodeInstallCommand(installApp, platform) === null) {
    return unsupportedOpenCodeForkMessage(installApp);
  }
  return null;
}

export function openCodeHealthResult(
  health: OpenCodeDiscoveryHealth,
  env: Readonly<Record<string, string | undefined>> = {},
  platform: NodeJS.Platform = process.platform,
): ProviderHealthResult {
  const block = installBlockMessage(health, env, platform);
  const installApp = chosenOpenCodeAppId(env, health);
  const installCommand =
    block === null && shouldOfferInstall(health)
      ? openCodeInstallCommand(installApp, platform)
      : null;
  const canInstall = installCommand !== null;
  return {
    supported: true,
    health: {
      status: health.status,
      statusMessage: block ?? health.statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion: health.installedVersion ?? health.version,
      minimumSupportedVersion: OPENCODE_MINIMUM_SUPPORTED_VERSION,
      canInstall,
      canUpdate: false,
      loginCommand: loginCommandFor(health),
    },
  };
}

export async function getOpenCodeProviderHealth(
  deps: OpenCodeMaintenanceDeps = {},
): Promise<ProviderHealthResult> {
  return openCodeHealthResult(
    await readHealth(deps),
    envOf(deps),
    platformOf(deps),
  );
}

export async function getOpenCodeProviderInstallationStatus(
  deps: OpenCodeMaintenanceDeps = {},
): Promise<ProviderInstallationStatus> {
  const env = envOf(deps);
  const platform = platformOf(deps);
  const health = await readHealth(deps);
  const resolvePath = deps.resolveExecutablePath ?? resolveExecutablePath;
  const latest = deps.npmLatestVersion ?? npmLatestVersion;
  const probeNpm = deps.probeNpmGlobalPackage ?? probeNpmGlobalPackage;
  const installApp = chosenOpenCodeAppId(env, health);
  const executableName = presentOpenCodeAppId(health) ?? installApp;
  const executablePath =
    (await resolvePath(executableName)) ??
    (executableName === "opencode" ? null : await resolvePath("opencode"));
  const block = installBlockMessage(health, env, platform);
  const installCommand =
    block === null && shouldOfferInstall(health)
      ? openCodeInstallCommand(installApp, platform)
      : null;
  const npmPackageName = npmPackageForApp(executableName);
  const [latestVersion, npmGlobal] = await Promise.all([
    npmPackageName === null ? Promise.resolve(null) : latest(npmPackageName),
    npmPackageName === null
      ? Promise.resolve({ npmBin: null, npmGlobalPackageVersion: null })
      : probeNpm(npmPackageName),
  ]);
  const installed =
    executablePath !== null ||
    health.version !== null ||
    health.status === "ready" ||
    health.status === "unknown" ||
    health.status === "unauthenticated" ||
    health.status === "unsupported_version";
  return {
    executableName,
    executablePath,
    installed,
    installSource: npmGlobalInstallSource({
      installed,
      executablePath,
      npmBin: npmGlobal.npmBin,
    }),
    currentVersion: health.installedVersion ?? health.version,
    latestVersion,
    minimumSupportedVersion: OPENCODE_MINIMUM_SUPPORTED_VERSION,
    npmPackageName,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      installCommand === null
        ? null
        : {
            kind: "install",
            label: "Install",
            command: installCommand.displayCommand,
          },
    needsUpdate: false,
    versionUnsupported: health.status === "unsupported_version",
  };
}

export async function getOpenCodeProviderInstallationRun(
  action: "install" | "update",
  deps: OpenCodeMaintenanceDeps = {},
): Promise<ProviderInstallationRunResult> {
  const env = envOf(deps);
  const platform = platformOf(deps);
  const health = await readHealth(deps);
  const block = installBlockMessage(health, env, platform);
  if (block !== null) {
    return { available: false, message: block };
  }
  const installApp = chosenOpenCodeAppId(env, health);
  const status = await getOpenCodeProviderInstallationStatus(deps);
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `OpenCode ${action} is no longer available on this host.`,
    };
  }
  const command = openCodeInstallCommand(installApp, platform);
  if (command === null) {
    return {
      available: false,
      message:
        installApp === "opencode" && platform === "win32"
          ? WINDOWS_OPENCODE_INSTALL_MESSAGE
          : unsupportedOpenCodeForkMessage(installApp),
    };
  }
  return {
    available: true,
    command,
    verification: installationVerification(status, action),
  };
}

export function describeOpenCodeInstallPlan(
  command: ProviderInstallationCommand,
): string {
  return formatCommand(command.command, command.args);
}
