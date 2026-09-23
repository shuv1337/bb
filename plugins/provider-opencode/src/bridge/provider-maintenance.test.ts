import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodeDiscoveryHealth } from "../runtime/index.js";
import {
  chosenOpenCodeAppId,
  getOpenCodeProviderHealth,
  getOpenCodeProviderInstallationRun,
  getOpenCodeProviderInstallationStatus,
  openCodeHealthResult,
  openCodeInstallCommand,
  OPENCODE_INSTALL_SCRIPT_URL,
  OPENCODE_REWIND_MINIMUM_SUPPORTED_VERSION,
  SHUVCODE_NPM_PACKAGE,
  WINDOWS_OPENCODE_INSTALL_MESSAGE,
  presentOpenCodeAppId,
  replacePresentAppMessage,
  unsupportedOpenCodeForkMessage,
} from "./provider-maintenance.js";

function health(
  overrides: Partial<OpenCodeDiscoveryHealth> = {},
): OpenCodeDiscoveryHealth {
  return {
    status: overrides.status ?? "not_installed",
    statusMessage:
      overrides.statusMessage ?? "No OpenCode v2 service or binary found",
    appId: overrides.appId ?? null,
    version: overrides.version ?? null,
    installedVersion: overrides.installedVersion ?? overrides.version ?? null,
    url: overrides.url ?? null,
    registrationFile: overrides.registrationFile ?? null,
    pid: overrides.pid ?? null,
    pathBinaryAppId: overrides.pathBinaryAppId ?? null,
  };
}

function supportedHealth(result: ProviderHealthResult) {
  expect(result.supported).toBe(true);
  if (result.supported !== true) {
    throw new Error("expected supported OpenCode health");
  }
  return result.health;
}

const emptyProbe = {
  resolveExecutablePath: async () => null,
  probeNpmGlobalPackage: async () => ({
    npmBin: null,
    npmGlobalPackageVersion: null,
  }),
};

describe("chosen OpenCode install app", () => {
  it("defaults to upstream when nothing is present", () => {
    expect(chosenOpenCodeAppId({})).toBe("opencode");
    expect(chosenOpenCodeAppId({ OPENCODE_APP: "shuvcode" })).toBe(
      "shuvcode",
    );
  });

  it("prefers a discovered shuvcode binary over the upstream default", () => {
    expect(
      chosenOpenCodeAppId(
        {},
        health({ pathBinaryAppId: "shuvcode", status: "unknown" }),
      ),
    ).toBe("shuvcode");
    expect(
      chosenOpenCodeAppId(
        { OPENCODE_APP: "opencode" },
        health({ pathBinaryAppId: "shuvcode" }),
      ),
    ).toBe("shuvcode");
  });

  it("prefers a stale registration app id when PATH is empty", () => {
    expect(
      presentOpenCodeAppId(health({ appId: "shuvcode", status: "unknown" })),
    ).toBe("shuvcode");
    expect(
      chosenOpenCodeAppId({}, health({ appId: "shuvcode", status: "unknown" })),
    ).toBe("shuvcode");
  });
});

describe("openCodeInstallCommand", () => {
  it("returns the v2 curl plan on unix and npm for shuvcode", () => {
    const upstream = openCodeInstallCommand("opencode", "linux");
    expect(upstream?.command).toBe("sh");
    expect(upstream?.displayCommand).toContain(OPENCODE_INSTALL_SCRIPT_URL);
    expect(OPENCODE_INSTALL_SCRIPT_URL).toBe("https://opencode.ai/v2/install");
    const fork = openCodeInstallCommand("shuvcode", "linux");
    expect(fork?.command).toMatch(/npm/);
    expect(fork?.args).toEqual(
      expect.arrayContaining([`${SHUVCODE_NPM_PACKAGE}@latest`]),
    );
    expect(openCodeInstallCommand("coolcode", "linux")).toBeNull();
  });

  it("does not return a shell installer for upstream OpenCode on Windows", () => {
    expect(openCodeInstallCommand("opencode", "win32")).toBeNull();
  });

  it("returns the npm plan for shuvcode on Windows", () => {
    const fork = openCodeInstallCommand("shuvcode", "win32");
    expect(fork?.command).toMatch(/npm/);
    expect(fork?.args).toEqual(
      expect.arrayContaining([`${SHUVCODE_NPM_PACKAGE}@latest`]),
    );
  });
});

describe("openCodeHealthResult", () => {
  it("maps a live service to ready without an install action", () => {
    const ready = supportedHealth(
      openCodeHealthResult(
        health({
          status: "ready",
          statusMessage: null,
          appId: "shuvcode",
          version: "2.0.8",
          url: "http://127.0.0.1:4096",
          pathBinaryAppId: "shuvcode",
        }),
      ),
    );
    expect(ready.status).toBe("ready");
    expect(ready.canInstall).toBe(false);
    expect(ready.canUpdate).toBe(false);
    expect(ready.installedVersion).toBe("2.0.8");
    expect(ready.loginCommand).toBe("shuvcode auth login");
  });

  it("maps explicit URL 401 to unauthenticated with no upstream install", () => {
    const unauthenticated = supportedHealth(
      openCodeHealthResult(
        health({
          status: "unauthenticated",
          statusMessage: "OpenCode rejected authentication",
          url: "http://127.0.0.1:4096",
        }),
      ),
    );
    expect(unauthenticated.status).toBe("unauthenticated");
    expect(unauthenticated.canInstall).toBe(false);
  });

  it("offers install only when nothing v2-capable is present", () => {
    const missing = supportedHealth(openCodeHealthResult(health(), {}, "linux"));
    expect(missing.status).toBe("not_installed");
    expect(missing.canInstall).toBe(true);
    const v1 = supportedHealth(
      openCodeHealthResult(
        health({
          status: "unsupported_version",
          statusMessage: "OpenCode v1 is not supported by this provider",
          pathBinaryAppId: "opencode",
        }),
        {},
        "linux",
      ),
    );
    expect(v1.canInstall).toBe(true);
  });

  it("refuses to replace an unsupported fork", () => {
    const blocked = supportedHealth(
      openCodeHealthResult(
        health({
          status: "unknown",
          statusMessage: "run `coolcode serve --service` or open the coolcode TUI",
          pathBinaryAppId: "coolcode",
          appId: "coolcode",
        }),
      ),
    );
    expect(blocked.canInstall).toBe(false);
    expect(blocked.statusMessage).toBe(
      unsupportedOpenCodeForkMessage("coolcode"),
    );
  });

  it("does not offer upstream install for a stale shuvcode registration with no PATH binary", () => {
    const stale = supportedHealth(
      openCodeHealthResult(
        health({
          status: "unknown",
          statusMessage: "run `shuvcode serve --service` or open the shuvcode TUI",
          appId: "shuvcode",
          pathBinaryAppId: null,
        }),
      ),
    );
    expect(stale.canInstall).toBe(false);
    expect(stale.statusMessage).toBe(
      "run `shuvcode serve --service` or open the shuvcode TUI",
    );
  });

  it("does not offer upstream install when an explicit URL probe fails", () => {
    const failedUrl = supportedHealth(
      openCodeHealthResult(
        health({
          status: "unknown",
          statusMessage:
            "OpenCode server at OPENCODE_SERVER_URL did not answer /api/info",
          url: "http://127.0.0.1:4096",
        }),
      ),
    );
    expect(failedUrl.canInstall).toBe(false);
  });
});

describe("OpenCode installation plans", () => {
  it("returns a v2 upstream install plan when nothing is installed", async () => {
    const deps = {
      env: {},
      platform: "linux" as const,
      health: async () => health(),
      ...emptyProbe,
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.installed).toBe(false);
    expect(status.executableName).toBe("opencode");
    expect(status.installAction?.kind).toBe("install");
    expect(status.installAction?.command).toContain(
      "https://opencode.ai/v2/install",
    );
    expect(status.needsUpdate).toBe(false);
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run.available).toBe(true);
    if (run.available) {
      expect(run.command.displayCommand).toContain(OPENCODE_INSTALL_SCRIPT_URL);
    }
  });

  it("returns a shuvcode npm plan when OPENCODE_APP selects it and nothing is present", async () => {
    const deps = {
      env: { OPENCODE_APP: "shuvcode" },
      platform: "linux" as const,
      health: async () => health(),
      ...emptyProbe,
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.executableName).toBe("shuvcode");
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run.available).toBe(true);
    if (run.available) {
      expect(run.command.args).toEqual(
        expect.arrayContaining([`${SHUVCODE_NPM_PACKAGE}@latest`]),
      );
    }
  });

  it("does not replace a present shuvcode binary with upstream even if OPENCODE_APP asks", async () => {
    const deps = {
      env: { OPENCODE_APP: "opencode" },
      platform: "linux" as const,
      health: async () =>
        health({
          status: "not_installed",
          pathBinaryAppId: "shuvcode",
          appId: "shuvcode",
        }),
      resolveExecutablePath: async (command: string) =>
        command === "shuvcode" ? "/usr/bin/shuvcode" : null,
      probeNpmGlobalPackage: async () => ({
        npmBin: null,
        npmGlobalPackageVersion: null,
      }),
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.executableName).toBe("shuvcode");
    expect(status.executablePath).toBe("/usr/bin/shuvcode");
    expect(status.installAction).toBeNull();
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run).toEqual({
      available: false,
      message: replacePresentAppMessage("shuvcode", "opencode"),
    });
  });

  it("does not offer an installer that would replace an unknown fork on PATH", async () => {
    const deps = {
      env: {},
      health: async () =>
        health({
          status: "unknown",
          pathBinaryAppId: "coolcode",
          appId: "coolcode",
        }),
      resolveExecutablePath: async (command: string) =>
        command === "coolcode" ? "/usr/bin/coolcode" : null,
      probeNpmGlobalPackage: async () => ({
        npmBin: null,
        npmGlobalPackageVersion: null,
      }),
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.installAction).toBeNull();
    expect(status.executableName).toBe("coolcode");
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run).toEqual({
      available: false,
      message: unsupportedOpenCodeForkMessage("coolcode"),
    });
  });

  it("does not offer upstream install for a stale fork registration with no PATH binary", async () => {
    const deps = {
      env: {},
      platform: "linux" as const,
      health: async () =>
        health({
          status: "unknown",
          appId: "shuvcode",
          pathBinaryAppId: null,
        }),
      ...emptyProbe,
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.executableName).toBe("shuvcode");
    expect(status.installAction).toBeNull();
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run.available).toBe(false);
  });

  it("does not offer upstream install when an explicit URL probe fails", async () => {
    const deps = {
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096" },
      platform: "linux" as const,
      health: async () =>
        health({
          status: "unknown",
          url: "http://127.0.0.1:4096",
          statusMessage:
            "OpenCode server at OPENCODE_SERVER_URL did not answer /api/info",
        }),
      ...emptyProbe,
    };
    const failedUrl = supportedHealth(await getOpenCodeProviderHealth(deps));
    expect(failedUrl.canInstall).toBe(false);
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run.available).toBe(false);
  });

  it("returns a shuvcode npm plan on Windows when OPENCODE_APP selects it", async () => {
    const deps = {
      env: { OPENCODE_APP: "shuvcode" },
      platform: "win32" as const,
      health: async () => health(),
      ...emptyProbe,
    };
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run.available).toBe(true);
    if (run.available) {
      expect(run.command.command).toMatch(/npm/);
      expect(run.command.args).toEqual(
        expect.arrayContaining([`${SHUVCODE_NPM_PACKAGE}@latest`]),
      );
    }
  });

  it("returns an unsupported message instead of a shell installer on Windows", async () => {
    const deps = {
      env: {},
      platform: "win32" as const,
      health: async () => health(),
      ...emptyProbe,
    };
    const windows = supportedHealth(await getOpenCodeProviderHealth(deps));
    expect(windows.canInstall).toBe(false);
    expect(windows.statusMessage).toBe(WINDOWS_OPENCODE_INSTALL_MESSAGE);
    const run = await getOpenCodeProviderInstallationRun("install", deps);
    expect(run).toEqual({
      available: false,
      message: WINDOWS_OPENCODE_INSTALL_MESSAGE,
    });
  });

  it("never offers update", async () => {
    const ready = supportedHealth(
      await getOpenCodeProviderHealth({
        health: async () =>
          health({
            status: "ready",
            version: "2.0.8",
            pathBinaryAppId: "shuvcode",
            appId: "shuvcode",
          }),
      }),
    );
    expect(ready.canUpdate).toBe(false);
    const run = await getOpenCodeProviderInstallationRun("update", {
      health: async () =>
        health({
          status: "ready",
          version: "2.0.8",
          pathBinaryAppId: "shuvcode",
        }),
      resolveExecutablePath: async (command: string) =>
        command === "shuvcode" ? "/opt/bin/shuvcode" : null,
      probeNpmGlobalPackage: async () => ({
        npmBin: null,
        npmGlobalPackageVersion: null,
      }),
    });
    expect(run.available).toBe(false);
  });
});

describe("OpenCode installation requirements", () => {
  it("reports the thread_rewind minimum for a rewind requirement", async () => {
    const status = await getOpenCodeProviderInstallationStatus({
      env: {},
      platform: "linux",
      health: async () =>
        health({ status: "unsupported_version", version: "1.9.0", appId: "opencode" }),
      ...emptyProbe,
      requirement: "thread_rewind",
    });
    expect(status.minimumSupportedVersion).toBe(
      OPENCODE_REWIND_MINIMUM_SUPPORTED_VERSION,
    );
    expect(status.versionUnsupported).toBe(true);
  });
});

describe("OpenCode installation probes", () => {
  it("probes discovery once per install run", async () => {
    let probes = 0;
    const run = await getOpenCodeProviderInstallationRun("install", {
      env: {},
      platform: "linux",
      health: async () => {
        probes += 1;
        return health();
      },
      ...emptyProbe,
    });
    expect(run.available).toBe(true);
    expect(probes).toBe(1);
  });

  it("does not query the npm registry for a latest version", async () => {
    let registryQueries = 0;
    const deps = {
      env: {},
      platform: "linux" as const,
      health: async () => health({ status: "ready", version: "2.0.8" }),
      ...emptyProbe,
      npmLatestVersion: async () => {
        registryQueries += 1;
        return "2.0.11";
      },
    };
    const status = await getOpenCodeProviderInstallationStatus(deps);
    expect(status.latestVersion).toBeNull();
    expect(registryQueries).toBe(0);
  });
});

describe("OpenCode install source", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(
      mkdtempSync(join(tmpdir(), "bb-opencode-install-source-")),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function readyDeps(args: {
    appId: "opencode" | "shuvcode";
    executablePath: string;
    npmGlobalPackageVersion: string | null;
    platform?: NodeJS.Platform;
  }) {
    return {
      env: {},
      platform: args.platform ?? "linux",
      health: async () =>
        health({
          status: "ready",
          version: "2.0.8",
          appId: args.appId,
          pathBinaryAppId: args.appId,
        }),
      resolveExecutablePath: async (command: string) =>
        command === args.appId ? args.executablePath : null,
      probeNpmGlobalPackage: async () => ({
        npmBin: join(root, "prefix", "bin"),
        npmGlobalPackageVersion: args.npmGlobalPackageVersion,
      }),
    };
  }

  it("reports npmGlobal when the binary resolves into the npm global package", async () => {
    const target = join(
      root,
      "prefix",
      "lib",
      "node_modules",
      SHUVCODE_NPM_PACKAGE,
      "bin",
      "shuvcode.js",
    );
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "");
    mkdirSync(join(root, "prefix", "bin"), { recursive: true });
    const link = join(root, "prefix", "bin", "shuvcode");
    symlinkSync(target, link);
    const status = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "shuvcode",
        executablePath: link,
        npmGlobalPackageVersion: "2.0.8",
      }),
    );
    expect(status.installSource).toBe("npmGlobal");
  });

  it("reports external for an installer binary that only sits in the npm bin directory", async () => {
    mkdirSync(join(root, "prefix", "bin"), { recursive: true });
    const binary = join(root, "prefix", "bin", "opencode");
    writeFileSync(binary, "");
    const status = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "opencode",
        executablePath: binary,
        npmGlobalPackageVersion: "2.0.8",
      }),
    );
    expect(status.installSource).toBe("external");
  });

  it("reports external when npm does not list the package globally", async () => {
    const target = join(
      root,
      "prefix",
      "lib",
      "node_modules",
      SHUVCODE_NPM_PACKAGE,
      "bin",
      "shuvcode.js",
    );
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "");
    mkdirSync(join(root, "prefix", "bin"), { recursive: true });
    const link = join(root, "prefix", "bin", "shuvcode");
    symlinkSync(target, link);
    const status = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "shuvcode",
        executablePath: link,
        npmGlobalPackageVersion: null,
      }),
    );
    expect(status.installSource).toBe("external");
  });

  it("reports npmGlobal when the npm prefix is reached through a symlink", async () => {
    const target = join(
      root,
      "real-prefix",
      "lib",
      "node_modules",
      SHUVCODE_NPM_PACKAGE,
      "bin",
      "shuvcode.js",
    );
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "");
    mkdirSync(join(root, "real-prefix", "bin"), { recursive: true });
    symlinkSync(target, join(root, "real-prefix", "bin", "shuvcode"));
    symlinkSync(join(root, "real-prefix"), join(root, "prefix"));
    const status = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "shuvcode",
        executablePath: join(root, "prefix", "bin", "shuvcode"),
        npmGlobalPackageVersion: "2.0.8",
      }),
    );
    expect(status.installSource).toBe("npmGlobal");
  });

  it("reports npmGlobal on Windows only for a shim inside the npm bin directory", async () => {
    const inside = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "shuvcode",
        executablePath: join(root, "prefix", "bin", "shuvcode.cmd"),
        npmGlobalPackageVersion: "2.0.8",
        platform: "win32",
      }),
    );
    expect(inside.installSource).toBe("npmGlobal");
    const outside = await getOpenCodeProviderInstallationStatus(
      readyDeps({
        appId: "shuvcode",
        executablePath: join(root, "elsewhere", "shuvcode.cmd"),
        npmGlobalPackageVersion: "2.0.8",
        platform: "win32",
      }),
    );
    expect(outside.installSource).toBe("external");
  });
});
