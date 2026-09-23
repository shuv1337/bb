import { homedir as osHomedir, networkInterfaces } from "node:os";
import { basename, delimiter, join } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CreateOpenCodeRuntimeOptions,
  OpenCodeDiscoveryHealth,
} from "./types.js";
import {
  INFO_PROBE_TIMEOUT_MS,
  REGISTRATION_PROBE_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
} from "./types.js";
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
  | "url"
  | "pid"
  | "remote"
  | "dead"
  | "unauthenticated"
  | "mismatch"
  | "unreachable"
  | "skipped";

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
  regularFileMtimeMs: (path: string) => Promise<number | null>;
  realpath: (path: string) => Promise<string>;
  isDirectory: (path: string) => Promise<boolean>;
  execVersion: (
    binary: string,
  ) => Promise<{ stdout: string; status: number }>;
  which: (command: string) => string | undefined;
  localAddresses: () => string[];
};

function hostInterfaceAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry.address);
  }
  return addresses;
}

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
    regularFileMtimeMs:
      options.regularFileMtimeMs ??
      (async (path) => {
        const info = await lstat(path);
        return info.isFile() ? info.mtimeMs : null;
      }),
    realpath: options.realpath ?? realpath,
    isDirectory:
      options.isDirectory ??
      (async (path) => {
        try {
          return (await lstat(path)).isDirectory();
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
            env,
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
        const parts = (env.PATH ?? "").split(delimiter);
        for (const dir of parts) {
          if (!dir) continue;
          const candidate = join(dir, command);
          try {
            if (!statSync(candidate).isFile()) continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
          } catch {
            continue;
          }
        }
        return undefined;
      }),
    localAddresses: options.localAddresses ?? hostInterfaceAddresses,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function httpHostname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isLoopbackUrl(url: string): boolean {
  const host = httpHostname(url);
  if (host === null) return false;
  if (host === "localhost" || host === "::1" || host === "::") return true;
  if (host === "0.0.0.0") return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isHostLocalUrl(
  url: string,
  localAddresses: readonly string[],
): boolean {
  if (isLoopbackUrl(url)) return true;
  const host = httpHostname(url);
  if (host === null) return false;
  return localAddresses.some((address) => address.toLowerCase() === host);
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function probeInfo(
  url: string,
  password: string | undefined,
  fetchImpl: typeof globalThis.fetch,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
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
  const timeout = AbortSignal.timeout(options.timeoutMs ?? INFO_PROBE_TIMEOUT_MS);
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, options.signal]);
  try {
    const response = await fetchImpl(new URL("/api/info", url), {
      headers,
      signal,
    });
    if (response.status === 401) {
      await discardBody(response);
      return { ok: false, status: 401, unauthenticated: true };
    }
    if (!response.ok) {
      await discardBody(response);
      return { ok: false, status: response.status, unauthenticated: false };
    }
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      !isPositiveInteger(body.pid) ||
      typeof body.version !== "string"
    ) {
      return { ok: false, status: response.status, unauthenticated: false };
    }
    return {
      ok: true,
      status: response.status,
      pid: body.pid,
      version: body.version,
      unauthenticated: false,
    };
  } catch {
    return { ok: false, status: 0, unauthenticated: false };
  }
}

export async function pathBinaryAppId(
  deps: DiscoveryDeps,
): Promise<PathBinaryProbe> {
  const results = await Promise.all(
    (["opencode", "shuvcode"] as const).map(async (command) => {
      const binary = deps.which(command);
      if (binary === undefined) return null;
      const result = await deps.execVersion(binary);
      if (result.status !== 0) return null;
      const parsed = parseVersionOutput(result.stdout);
      return parsed.appId === null ? { ...parsed, appId: command } : parsed;
    }),
  );
  const probes = results.filter(
    (probe): probe is ParsedVersion => probe !== null,
  );
  const v2 = probes.find((probe) => !probe.isV1);
  const v1Only = probes.length > 0 && v2 === undefined;
  return {
    appId: v2?.appId ?? null,
    installedVersion: v2?.version ?? probes[0]?.version ?? null,
    v1Only,
  };
}

const STATE_ROOT_NAMES = [
  "opencode",
  "shuvcode",
  join("opencode-next", "opencode"),
] as const;

function isPlainAppName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function requestedAppOf(deps: DiscoveryDeps): string | null {
  const requested = deps.env.BB_OPENCODE_APP?.trim();
  return requested !== undefined && requested.length > 0 ? requested : null;
}

async function collectStateRoots(deps: DiscoveryDeps): Promise<string[]> {
  const xdg =
    deps.env.XDG_STATE_HOME && deps.env.XDG_STATE_HOME.length > 0
      ? deps.env.XDG_STATE_HOME
      : join(deps.homedir, ".local", "state");
  const names: string[] = [...STATE_ROOT_NAMES];
  const requested = requestedAppOf(deps);
  if (requested !== null && isPlainAppName(requested)) names.push(requested);
  let xdgReal = xdg;
  try {
    xdgReal = await deps.realpath(xdg);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const name of names) {
    const candidate = join(xdg, name);
    if (!(await deps.isDirectory(candidate))) continue;
    let resolved: string;
    try {
      resolved = await deps.realpath(candidate);
    } catch {
      continue;
    }
    if (resolved !== join(xdgReal, name)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(candidate);
  }
  return roots;
}

function isServiceJsonName(name: string): boolean {
  if (name.endsWith(".lock") || name.endsWith(".bak")) return false;
  return /^service.*\.json$/.test(name);
}

async function listRegistrations(
  deps: DiscoveryDeps,
): Promise<RegistrationCandidate[]> {
  const roots = await collectStateRoots(deps);
  const localAddresses = deps.localAddresses();
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
      let mtimeMs: number | null = null;
      try {
        mtimeMs = await deps.regularFileMtimeMs(file);
      } catch {
        continue;
      }
      if (mtimeMs === null) continue;
      const failed = (
        failure: RegistrationProbeFailure,
        fields: { url?: string; pid?: number } = {},
      ): RegistrationCandidate => ({
        appId,
        file,
        url: fields.url ?? "",
        pid: fields.pid ?? 0,
        mtimeMs: mtimeMs ?? 0,
        failure,
      });
      let raw: unknown;
      try {
        raw = JSON.parse(await deps.readFile(file));
      } catch {
        candidates.push(failed("parse"));
        continue;
      }
      if (!isRecord(raw)) {
        candidates.push(failed("parse"));
        continue;
      }
      const rawUrl = typeof raw.url === "string" ? raw.url : undefined;
      const rawPid = typeof raw.pid === "number" ? raw.pid : undefined;
      if (rawUrl === undefined || !isHttpUrl(rawUrl)) {
        candidates.push(failed("url", { url: rawUrl, pid: rawPid }));
        continue;
      }
      if (!isPositiveInteger(raw.pid)) {
        candidates.push(failed("pid", { url: rawUrl, pid: rawPid }));
        continue;
      }
      const base = {
        appId,
        file,
        url: rawUrl,
        pid: raw.pid,
        password: typeof raw.password === "string" ? raw.password : undefined,
        version: typeof raw.version === "string" ? raw.version : undefined,
        mtimeMs,
      };
      if (!isHostLocalUrl(rawUrl, localAddresses)) {
        candidates.push({ ...base, failure: "remote" });
        continue;
      }
      if (!deps.kill(raw.pid, 0)) {
        candidates.push({ ...base, failure: "dead" });
        continue;
      }
      candidates.push({ ...base, failure: null });
    }
  }
  return candidates;
}

async function probeCandidate(
  deps: DiscoveryDeps,
  candidate: RegistrationCandidate,
  signal: AbortSignal,
): Promise<RegistrationCandidate> {
  const info = await probeInfo(candidate.url, candidate.password, deps.fetch, {
    timeoutMs: REGISTRATION_PROBE_TIMEOUT_MS,
    signal,
  });
  if (info.unauthenticated) return { ...candidate, failure: "unauthenticated" };
  if (!info.ok) return { ...candidate, failure: "unreachable" };
  if (info.pid !== candidate.pid) return { ...candidate, failure: "mismatch" };
  return {
    ...candidate,
    version: candidate.version ?? info.version,
    failure: null,
  };
}

async function probeRegistrations(
  deps: DiscoveryDeps,
  listed: readonly RegistrationCandidate[],
  rank?: (candidate: RegistrationCandidate) => number,
): Promise<RegistrationCandidate[]> {
  const controller = new AbortController();
  const probes = new Map<RegistrationCandidate, Promise<RegistrationCandidate>>();
  for (const candidate of listed) {
    if (candidate.failure !== null) continue;
    probes.set(candidate, probeCandidate(deps, candidate, controller.signal));
  }
  const settled = new Map<RegistrationCandidate, RegistrationCandidate>();
  if (rank === undefined) {
    for (const [candidate, probe] of probes) settled.set(candidate, await probe);
  } else {
    const ordered = [...probes.keys()].sort(
      (left, right) =>
        rank(left) - rank(right) || right.mtimeMs - left.mtimeMs,
    );
    for (const candidate of ordered) {
      const probe = probes.get(candidate);
      if (probe === undefined) continue;
      const result = await probe;
      settled.set(candidate, result);
      if (result.failure === null) break;
    }
    controller.abort();
  }
  return listed.map(
    (candidate) =>
      settled.get(candidate) ??
      (candidate.failure === null
        ? { ...candidate, failure: "skipped" }
        : candidate),
  );
}

export async function scanRegistrations(
  deps: DiscoveryDeps,
): Promise<RegistrationCandidate[]> {
  return probeRegistrations(deps, await listRegistrations(deps));
}

export async function scanLiveRegistrations(
  deps: DiscoveryDeps,
): Promise<LiveRegistration[]> {
  return (await scanRegistrations(deps)).filter(
    (candidate) => candidate.failure === null,
  );
}

export async function registrationStillLive(
  deps: DiscoveryDeps,
  registration: LiveRegistration,
  explicit: boolean,
): Promise<boolean> {
  if (!explicit && !deps.kill(registration.pid, 0)) return false;
  const info = await probeInfo(registration.url, registration.password, deps.fetch, {
    timeoutMs: explicit ? INFO_PROBE_TIMEOUT_MS : REGISTRATION_PROBE_TIMEOUT_MS,
  });
  return info.ok && info.pid === registration.pid;
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

  const [pathApp, listed] = await Promise.all([
    pathBinaryAppId(deps),
    listRegistrations(deps),
  ]);
  const requested = requestedAppOf(deps);
  const candidates = await probeRegistrations(deps, listed, (candidate) => {
    if (requested !== null && candidate.appId === requested) return 0;
    if (pathApp.appId !== null && candidate.appId === pathApp.appId) return 1;
    return 2;
  });
  const live = candidates.filter((item) => item.failure === null);
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

  const remote = candidates.find((item) => item.failure === "remote");
  if (remote) {
    return {
      explicit: false,
      registration: null,
      health: {
        status: "unknown",
        statusMessage: `${remote.appId} is registered at a URL that is not on this host; set BB_OPENCODE_SERVER to attach to it`,
        appId: remote.appId,
        version: remote.version ?? pathApp.installedVersion,
        installedVersion: pathApp.installedVersion,
        url: remote.url,
        registrationFile: remote.file,
        pid: null,
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
