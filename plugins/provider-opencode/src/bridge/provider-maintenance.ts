import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRequirement,
  type ProviderInstallationRunResult,
  type ProviderInstallationSource,
  type ProviderInstallationStatus,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_resolveExecutablePath as resolveExecutablePath,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  discoveryDepsFrom,
  resolveAttachedRegistration,
} from "../runtime/discovery.js";
import type { OpenCodeDiscoveryHealth } from "../runtime/index.js";

export const OPENCODE_MINIMUM_SUPPORTED_VERSION = "2.0.0";
export const OPENCODE_REWIND_MINIMUM_SUPPORTED_VERSION = OPENCODE_MINIMUM_SUPPORTED_VERSION;
export const OPENCODE_NPM_PACKAGE = "@opencode/cli";
export const SHUVCODE_NPM_PACKAGE = "shuvcode";
export const OPENCODE_INSTALL_SCRIPT_URL = "https://opencode.ai/v2/install";
export const KNOWN_OPENCODE_APPS = ["opencode", "shuvcode"] as const;
export const OPENCODE_INSTALL_DEFAULT_APP_ID = "shuvcode";
export const WINDOWS_OPENCODE_INSTALL_MESSAGE =
  "bb cannot install upstream OpenCode on Windows. Download the Windows CLI from https://opencode.ai/v2/docs/";

export type KnownOpenCodeAppId = (typeof KNOWN_OPENCODE_APPS)[number];

export type OpenCodeMaintenanceDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  health?: () => Promise<OpenCodeDiscoveryHealth>;
  resolveExecutablePath?: typeof resolveExecutablePath;
  probeNpmGlobalPackage?: typeof probeNpmGlobalPackage;
  realpath?: (filePath: string) => Promise<string>;
  requirement?: ProviderInstallationRequirement;
};

export function minimumSupportedOpenCodeVersion(
  requirement: ProviderInstallationRequirement | undefined,
): string {
  return requirement === "thread_rewind"
    ? OPENCODE_REWIND_MINIMUM_SUPPORTED_VERSION
    : OPENCODE_MINIMUM_SUPPORTED_VERSION;
}

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
  health?: Pick<OpenCodeDiscoveryHealth, "status" | "appId" | "pathBinaryAppId">,
): string {
  const requested = env.OPENCODE_APP?.trim() ?? "";
  const present = health === undefined ? null : presentOpenCodeAppId(health);
  if (present !== null) return present;
  if (requested.length > 0) return requested;
  if (health === undefined || health.status === "not_installed") {
    return OPENCODE_INSTALL_DEFAULT_APP_ID;
  }
  return "opencode";
}

export function unsupportedOpenCodeForkMessage(appId: string): string {
  return `bb does not install "${appId}". Start it with \`${appId} serve --service\` or set OPENCODE_SERVER_URL to that service. Never replace a fork with upstream OpenCode.`;
}

export function replacePresentAppMessage(
  present: string,
  requested: string,
): string {
  return `bb will not replace "${present}" with "${requested}". Start \`${present} serve --service\` or set OPENCODE_APP=${present}.`;
}

export function windowsOpenCodeInstallMessage(
  health: Pick<OpenCodeDiscoveryHealth, "status" | "appId" | "pathBinaryAppId">,
): string {
  return health.status === "not_installed" &&
    presentOpenCodeAppId(health) === null
    ? `${WINDOWS_OPENCODE_INSTALL_MESSAGE}, or unset OPENCODE_APP to install shuvcode with npm.`
    : WINDOWS_OPENCODE_INSTALL_MESSAGE;
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

function loginCommandFor(
  health: OpenCodeDiscoveryHealth,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return `${chosenOpenCodeAppId(env, health)} auth login`;
}

export function notInstalledOpenCodeMessage(
  installApp: string,
  command: ProviderInstallationCommand,
): string {
  const install = `No OpenCode v2 service or binary found. Install runs \`${command.displayCommand}\`.`;
  return installApp === OPENCODE_INSTALL_DEFAULT_APP_ID
    ? `${install} Set OPENCODE_APP=opencode to install upstream OpenCode v2 instead.`
    : install;
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
  const requested = env.OPENCODE_APP?.trim() ?? "";
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
    return windowsOpenCodeInstallMessage(health);
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
  const installMessage =
    installCommand !== null && health.status === "not_installed"
      ? notInstalledOpenCodeMessage(installApp, installCommand)
      : null;
  return {
    supported: true,
    health: {
      status: health.status,
      statusMessage: block ?? installMessage ?? health.statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion: health.installedVersion ?? health.version,
      minimumSupportedVersion: OPENCODE_MINIMUM_SUPPORTED_VERSION,
      canInstall,
      canUpdate: false,
      loginCommand: loginCommandFor(health, env),
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

function isPathInside(parent: string, child: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function openCodeInstallSource(args: {
  installed: boolean;
  executablePath: string | null;
  npmPackageName: string | null;
  npmBin: string | null;
  npmGlobalPackageVersion: string | null;
  platform: NodeJS.Platform;
  realpath: (filePath: string) => Promise<string>;
}): Promise<ProviderInstallationSource> {
  if (!args.installed) return "notInstalled";
  if (
    args.executablePath === null ||
    args.npmPackageName === null ||
    args.npmBin === null ||
    args.npmGlobalPackageVersion === null ||
    !isPathInside(args.npmBin, args.executablePath)
  ) {
    return "external";
  }
  if (args.platform === "win32") return "npmGlobal";
  const packageDirectory = path.join(
    path.dirname(args.npmBin),
    "lib",
    "node_modules",
    args.npmPackageName,
  );
  const target = await args.realpath(args.executablePath).catch(() => null);
  const realPackageDirectory = await args
    .realpath(packageDirectory)
    .catch(() => packageDirectory);
  return target !== null && isPathInside(realPackageDirectory, target)
    ? "npmGlobal"
    : "external";
}

async function installationStatusFor(
  deps: OpenCodeMaintenanceDeps,
  health: OpenCodeDiscoveryHealth,
): Promise<ProviderInstallationStatus> {
  const env = envOf(deps);
  const platform = platformOf(deps);
  const resolvePath = deps.resolveExecutablePath ?? resolveExecutablePath;
  const probeNpm = deps.probeNpmGlobalPackage ?? probeNpmGlobalPackage;
  const installApp = chosenOpenCodeAppId(env, health);
  const present = presentOpenCodeAppId(health);
  const executableName = present ?? installApp;
  const executablePath =
    (await resolvePath(executableName)) ??
    (present === null || executableName === "opencode"
      ? null
      : await resolvePath("opencode"));
  const block = installBlockMessage(health, env, platform);
  const installCommand =
    block === null && shouldOfferInstall(health)
      ? openCodeInstallCommand(installApp, platform)
      : null;
  const npmPackageName = npmPackageForApp(executableName);
  const npmGlobal =
    npmPackageName === null
      ? { npmBin: null, npmGlobalPackageVersion: null }
      : await probeNpm(npmPackageName);
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
    installSource: await openCodeInstallSource({
      installed,
      executablePath,
      npmPackageName,
      npmBin: npmGlobal.npmBin,
      npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
      platform,
      realpath: deps.realpath ?? realpath,
    }),
    currentVersion: health.installedVersion ?? health.version,
    latestVersion: null,
    minimumSupportedVersion: minimumSupportedOpenCodeVersion(deps.requirement),
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

export async function getOpenCodeProviderInstallationStatus(
  deps: OpenCodeMaintenanceDeps = {},
): Promise<ProviderInstallationStatus> {
  return installationStatusFor(deps, await readHealth(deps));
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
  const status = await installationStatusFor(deps, health);
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
          ? windowsOpenCodeInstallMessage(health)
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
