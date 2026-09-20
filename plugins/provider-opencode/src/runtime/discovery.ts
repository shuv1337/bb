import { homedir as osHomedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { accessSync, constants } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CreateOpenCodeRuntimeOptions,
  OpenCodeDiscoveryHealth,
} from "./types.js";
import { INFO_PROBE_TIMEOUT_MS, VERSION_PROBE_TIMEOUT_MS } from "./types.js";
import { sanitizeErrorMessage } from "./errors.js";

const execFileAsync = promisify(execFile);

export type LiveRegistration = {
  appId: string;
  file: string;
  url: string;
  pid: number;
  password?: string;
  version?: string;
  mtimeMs: number;
};

export type RegistrationProbeFailure =
  | "parse"
  | "pid"
  | "dead"
  | "unauthenticated"
  | "mismatch"
  | "unreachable";

export type RegistrationCandidate = LiveRegistration & {
  failure: RegistrationProbeFailure | null;
};

export type PathBinaryProbe = {
  appId: string | null;
  installedVersion: string | null;
  v1Only: boolean;
};

type DiscoveryDeps = {
  env: NodeJS.ProcessEnv;
  homedir: string;
  fetch: typeof globalThis.fetch;
  kill: (pid: number, signal: 0) => boolean;
  readFile: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  statMtimeMs: (path: string) => Promise<number>;
  realpath: (path: string) => Promise<string>;
  isDirectory: (path: string) => Promise<boolean>;
  execVersion: (
    binary: string,
  ) => Promise<{ stdout: string; status: number }>;
  which: (command: string) => string | undefined;
};

export function discoveryDepsFrom(
  options: CreateOpenCodeRuntimeOptions = {},
): DiscoveryDeps {
  const env = options.env ?? process.env;
  return {
    env,
    homedir: options.homedir ?? osHomedir(),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    kill:
      options.kill ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }),
    readFile: options.readFile ?? ((path) => readFile(path, "utf8")),
    readdir: options.readdir ?? (async (path) => readdir(path)),
    statMtimeMs:
      options.statMtimeMs ?? (async (path) => (await stat(path)).mtimeMs),
    realpath: options.realpath ?? realpath,
    isDirectory:
      options.isDirectory ??
      (async (path) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      }),
    execVersion:
      options.execVersion ??
      (async (binary) => {
        try {
          const result = await execFileAsync(binary, ["--version"], {
            timeout: VERSION_PROBE_TIMEOUT_MS,
            env: process.env,
          });
          return { stdout: result.stdout, status: 0 };
        } catch (error) {
          const err = error as {
            stdout?: string;
            status?: number | null;
          };
          return {
            stdout: typeof err.stdout === "string" ? err.stdout : "",
            status: typeof err.status === "number" ? err.status : 1,
          };
        }
      }),
    which:
      options.which ??
      ((command) => {
        const pathEnv = env.PATH ?? process.env.PATH ?? "";
        const parts = pathEnv.split(delimiter);
        for (const dir of parts) {
          if (!dir) continue;
          const candidate = join(dir, command);
          try {
            accessSync(candidate, constants.X_OK);
            return candidate;
          } catch {
            continue;
          }
        }
        return undefined;
      }),
  };
}

export function basicAuthHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

export type ParsedVersion = {
  appId: string | null;
  version: string | null;
  isV1: boolean;
};

export function parseVersionOutput(stdout: string): ParsedVersion {
  const line = stdout.trim().split(/\r?\n/)[0] ?? "";
  const branded = /^([A-Za-z][A-Za-z0-9._-]*)\s+v?(\d+\.\S*)/.exec(line);
  if (branded) {
    const version = branded[2] ?? null;
    return {
      appId: branded[1] ?? null,
      version,
      isV1: isV1Version(version),
    };
  }
  const bare = /^v?(\d+\.\S*)/.exec(line);
  if (bare) {
    const version = bare[1] ?? null;
    return { appId: null, version, isV1: isV1Version(version) };
  }
  return { appId: null, version: null, isV1: false };
}

export function parseAppIdFromVersion(stdout: string): string | null {
  return parseVersionOutput(stdout).appId;
}

export function isV1VersionOutput(stdout: string): boolean {
  return parseVersionOutput(stdout).isV1;
}

function isV1Version(version: string | null): boolean {
  if (version === null) return false;
  return /^1([.-]|$)/.test(version);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export async function probeInfo(
  url: string,
  password: string | undefined,
  fetchImpl: typeof globalThis.fetch,
): Promise<{
  ok: boolean;
  status: number;
  pid?: number;
  version?: string;
  unauthenticated: boolean;
}> {
  const headers: Record<string, string> = {};
  if (password !== undefined) {
    headers.authorization = basicAuthHeader(password);
  }
  try {
    const response = await fetchImpl(new URL("/api/info", url), {
      headers,
      signal: AbortSignal.timeout(INFO_PROBE_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return { ok: false, status: 401, unauthenticated: true };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, unauthenticated: false };
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("pid" in body) ||
      !isPositiveInteger((body as { pid: unknown }).pid) ||
      !("version" in body) ||
      typeof (body as { version: unknown }).version !== "string"
    ) {
      return { ok: false, status: response.status, unauthenticated: false };
    }
    return {
      ok: true,
      status: response.status,
      pid: (body as { pid: number }).pid,
      version: (body as { version: string }).version,
      unauthenticated: false,
    };
  } catch {
    return { ok: false, status: 0, unauthenticated: false };
  }
}

export async function pathBinaryAppId(
  deps: DiscoveryDeps,
): Promise<PathBinaryProbe> {
  const probes: ParsedVersion[] = [];
  for (const command of ["opencode", "shuvcode"] as const) {
    const binary = deps.which(command);
    if (binary === undefined) continue;
    const result = await deps.execVersion(binary);
    if (result.status !== 0) continue;
    const parsed = parseVersionOutput(result.stdout);
    if (parsed.appId === null && command === "shuvcode") {
      probes.push({ ...parsed, appId: "shuvcode" });
    } else if (parsed.appId === null && command === "opencode") {
      probes.push({ ...parsed, appId: parsed.isV1 ? "opencode" : "opencode" });
    } else {
      probes.push(parsed);
    }
  }
  const v2 = probes.find((probe) => !probe.isV1);
  const v1Only = probes.length > 0 && v2 === undefined;
  return {
    appId: v2?.appId ?? null,
    installedVersion: v2?.version ?? probes[0]?.version ?? null,
    v1Only,
  };
}

async function collectStateRoots(deps: DiscoveryDeps): Promise<string[]> {
  const xdg =
    deps.env.XDG_STATE_HOME && deps.env.XDG_STATE_HOME.length > 0
      ? deps.env.XDG_STATE_HOME
      : join(deps.homedir, ".local", "state");
  const ordered = [
    join(xdg, "opencode"),
    join(xdg, "shuvcode"),
    join(xdg, "opencode-next", "opencode"),
  ];
  let names: string[] = [];
  try {
    names = await deps.readdir(xdg);
  } catch {
    names = [];
  }
  for (const name of names) {
    ordered.push(join(xdg, name, "opencode"));
  }
  for (const name of names) {
    ordered.push(join(xdg, name));
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of ordered) {
    if (!(await deps.isDirectory(candidate))) continue;
    let key = candidate;
    try {
      key = await deps.realpath(candidate);
    } catch {
      key = candidate;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

function isServiceJsonName(name: string): boolean {
  if (name.endsWith(".lock") || name.endsWith(".bak")) return false;
  return /^service.*\.json$/.test(name);
}

export async function scanRegistrations(
  deps: DiscoveryDeps,
): Promise<RegistrationCandidate[]> {
  const roots = await collectStateRoots(deps);
  const candidates: RegistrationCandidate[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await deps.readdir(root);
    } catch {
      continue;
    }
    const appId = basename(root);
    for (const name of names) {
      if (!isServiceJsonName(name)) continue;
      const file = join(root, name);
      let mtimeMs = 0;
      try {
        mtimeMs = await deps.statMtimeMs(file);
      } catch {
        mtimeMs = 0;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await deps.readFile(file));
      } catch {
        candidates.push({
          appId,
          file,
          url: "",
          pid: 0,
          mtimeMs,
          failure: "parse",
        });
        continue;
      }
      if (typeof raw !== "object" || raw === null) {
        candidates.push({
          appId,
          file,
          url: "",
          pid: 0,
          mtimeMs,
          failure: "parse",
        });
        continue;
      }
      const record = raw as Record<string, unknown>;
      if (typeof record.url !== "string" || !isPositiveInteger(record.pid)) {
        candidates.push({
          appId,
          file,
          url: typeof record.url === "string" ? record.url : "",
          pid: typeof record.pid === "number" ? record.pid : 0,
          mtimeMs,
          failure: "pid",
        });
        continue;
      }
      const password =
        typeof record.password === "string" ? record.password : undefined;
      const version =
        typeof record.version === "string" ? record.version : undefined;
      const base = {
        appId,
        file,
        url: record.url,
        pid: record.pid,
        password,
        version,
        mtimeMs,
      };
      if (!deps.kill(record.pid, 0)) {
        candidates.push({ ...base, failure: "dead" });
        continue;
      }
      const info = await probeInfo(record.url, password, deps.fetch);
      if (info.unauthenticated) {
        candidates.push({ ...base, failure: "unauthenticated" });
        continue;
      }
      if (!info.ok) {
        candidates.push({ ...base, failure: "unreachable" });
        continue;
      }
      if (info.pid !== record.pid) {
        candidates.push({ ...base, failure: "mismatch" });
        continue;
      }
      candidates.push({
        ...base,
        version: version ?? info.version,
        failure: null,
      });
    }
  }
  return candidates;
}

export async function scanLiveRegistrations(
  deps: DiscoveryDeps,
): Promise<LiveRegistration[]> {
  return (await scanRegistrations(deps)).filter(
    (candidate) => candidate.failure === null,
  );
}

function newest(
  items: readonly LiveRegistration[],
): LiveRegistration | null {
  return [...items].sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null;
}

export function selectLiveRegistration(
  live: readonly LiveRegistration[],
  requestedAppId: string | null,
  pathAppId?: string | null,
): LiveRegistration | null {
  if (live.length === 0) return null;
  if (requestedAppId) {
    const match = newest(live.filter((item) => item.appId === requestedAppId));
    if (match) return match;
  }
  if (pathAppId) {
    const match = newest(live.filter((item) => item.appId === pathAppId));
    if (match) return match;
  }
  return newest(live);
}

function chosenAppId(input: {
  requested?: string;
  pathAppId: string | null;
  candidates: readonly RegistrationCandidate[];
}): string {
  if (input.requested) return input.requested;
  if (input.pathAppId) return input.pathAppId;
  const liveApp = input.candidates.find((item) => item.failure === null)?.appId;
  if (liveApp) return liveApp;
  const staleApp = input.candidates[0]?.appId;
  return staleApp ?? "opencode";
}

export async function resolveAttachedRegistration(
  deps: DiscoveryDeps,
): Promise<{
  health: OpenCodeDiscoveryHealth;
  registration: LiveRegistration | null;
  explicit: boolean;
}> {
  const server = deps.env.BB_OPENCODE_SERVER?.trim();
  if (server !== undefined && server.length > 0) {
    const password = deps.env.BB_OPENCODE_PASSWORD;
    const info = await probeInfo(server, password, deps.fetch);
    if (info.unauthenticated) {
      return {
        explicit: true,
        registration: null,
        health: {
          status: "unauthenticated",
          statusMessage: "OpenCode rejected authentication",
          appId: null,
          version: null,
          installedVersion: null,
          url: server,
          registrationFile: null,
          pid: null,
          pathBinaryAppId: null,
        },
      };
    }
    if (!info.ok || !isPositiveInteger(info.pid)) {
      return {
        explicit: true,
        registration: null,
        health: {
          status: "unknown",
          statusMessage: sanitizeErrorMessage(
            "OpenCode server at BB_OPENCODE_SERVER did not answer /api/info",
          ),
          appId: null,
          version: null,
          installedVersion: null,
          url: server,
          registrationFile: null,
          pid: null,
          pathBinaryAppId: null,
        },
      };
    }
    return {
      explicit: true,
      registration: {
        appId: "opencode",
        file: "",
        url: server,
        pid: info.pid,
        password,
        version: info.version,
        mtimeMs: 0,
      },
      health: {
        status: "ready",
        statusMessage: null,
        appId: null,
        version: info.version ?? null,
        installedVersion: info.version ?? null,
        url: server,
        registrationFile: null,
        pid: info.pid,
        pathBinaryAppId: null,
      },
    };
  }

  const pathApp = await pathBinaryAppId(deps);
  const candidates = await scanRegistrations(deps);
  const live = candidates.filter((item) => item.failure === null);
  const requested = deps.env.BB_OPENCODE_APP?.trim() || null;
  const selected = selectLiveRegistration(live, requested, pathApp.appId);
  if (selected) {
    return {
      explicit: false,
      registration: selected,
      health: {
        status: "ready",
        statusMessage: null,
        appId: selected.appId,
        version: selected.version ?? null,
        installedVersion: pathApp.installedVersion,
        url: selected.url,
        registrationFile: selected.file,
        pid: selected.pid,
        pathBinaryAppId: pathApp.appId,
      },
    };
  }

  const app = chosenAppId({
    requested: requested ?? undefined,
    pathAppId: pathApp.appId,
    candidates,
  });
  const unauthorized = candidates.find(
    (item) => item.failure === "unauthenticated",
  );
  if (unauthorized) {
    return {
      explicit: false,
      registration: null,
      health: {
        status: "unauthenticated",
        statusMessage: "OpenCode rejected authentication",
        appId: unauthorized.appId,
        version: unauthorized.version ?? pathApp.installedVersion,
        installedVersion: pathApp.installedVersion,
        url: unauthorized.url || null,
        registrationFile: unauthorized.file,
        pid: unauthorized.pid || null,
        pathBinaryAppId: pathApp.appId,
      },
    };
  }

  if (candidates.length > 0) {
    return {
      explicit: false,
      registration: null,
      health: {
        status: "unknown",
        statusMessage: `run \`${app} serve --service\` or open the ${app} TUI`,
        appId: app,
        version: pathApp.installedVersion,
        installedVersion: pathApp.installedVersion,
        url: null,
        registrationFile: candidates[0]?.file ?? null,
        pid: null,
        pathBinaryAppId: pathApp.appId,
      },
    };
  }

  if (pathApp.v1Only) {
    return {
      explicit: false,
      registration: null,
      health: {
        status: "unsupported_version",
        statusMessage: "OpenCode v1 is not supported by this provider",
        appId: pathApp.appId,
        version: pathApp.installedVersion,
        installedVersion: pathApp.installedVersion,
        url: null,
        registrationFile: null,
        pid: null,
        pathBinaryAppId: pathApp.appId,
      },
    };
  }

  if (pathApp.appId === null) {
    return {
      explicit: false,
      registration: null,
      health: {
        status: "not_installed",
        statusMessage: "No OpenCode v2 service or binary found",
        appId: null,
        version: null,
        installedVersion: null,
        url: null,
        registrationFile: null,
        pid: null,
        pathBinaryAppId: null,
      },
    };
  }

  return {
    explicit: false,
    registration: null,
    health: {
      status: "unknown",
      statusMessage: `run \`${app} serve --service\` or open the ${app} TUI`,
      appId: app,
      version: pathApp.installedVersion,
      installedVersion: pathApp.installedVersion,
      url: null,
      registrationFile: null,
      pid: null,
      pathBinaryAppId: pathApp.appId,
    },
  };
}
