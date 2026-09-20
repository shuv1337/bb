# OpenCode runtime seam

Bridge consumes **only** `plugins/provider-opencode/src/runtime/index.ts` (plus `../models.ts` and `../permissions.ts`). HTTP, SSE, `service*.json`, and `@opencode/client` stay behind this module.

Pinned client: `@opencode/client@2.0.10`, imports `@opencode/client/promise` and `@opencode/client/service` only. Never `Service.ensure`, never `./effect`, never `./solid`, never `@opencode/sdk`, never `@bb/*`.

## Factory

```ts
createOpenCodeRuntime(options?: CreateOpenCodeRuntimeOptions): Promise<OpenCodeRuntime>
createFakeOpenCodeRuntime(options?: CreateFakeOpenCodeRuntimeOptions): OpenCodeRuntime
```

`createOpenCodeRuntime` attaches; it does not spawn. Order:

1. `BB_OPENCODE_SERVER` (+ optional `BB_OPENCODE_PASSWORD`) → explicit URL. No filesystem scan and no PATH `--version` probe.
2. Else read-only scan of `$XDG_STATE_HOME` (default `~/.local/state`) `service*.json`.

No auto-start. A runtime may be constructed while unhealthy. `health()` re-resolves and **reattaches** the HTTP client when a usable URL appears. `status: "ready"` is never returned without an attached client on a non-zero port. Session methods throw `OpenCodeRuntimeNotReadyError` until then.

## Health (maintenance)

`runtime.health(): Promise<OpenCodeDiscoveryHealth>`

```ts
type OpenCodeHealthStatus =
  | "ready"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "unsupported_version"
  | "unknown"

type OpenCodeDiscoveryHealth = {
  status: OpenCodeHealthStatus
  statusMessage: string | null
  appId: string | null
  version: string | null
  installedVersion: string | null
  url: string | null
  registrationFile: string | null
  pid: number | null
  pathBinaryAppId: string | null
}
```

| Situation | status |
| --- | --- |
| Live v2 `/api/info` 200 pid match | `ready` |
| Explicit URL / registration 401 | `unauthenticated` |
| Dead/stale/corrupt registration, no live pid | `unknown` + `run \`<app> serve --service\`` using requested/PATH/file app |
| Live pid, wrong registration password | `unauthenticated` |
| PATH `--version` is v1 (`1.x` or `opencode v1.x`) and no v2 binary/service | `unsupported_version` |
| No v2 binary and no registration files | `not_installed` |

Errors are sanitized (no password, no `Authorization`). `expired` is unused.

## Discovery scan

Glob `$XDG_STATE_HOME/<root>/service*.json`. Ignore `*.lock`, `*.bak`. Roots, realpath-deduped, in order then extras:

1. `opencode/`
2. `shuvcode/`
3. `opencode-next/opencode/`
4. `*/opencode/`
5. every other `*/`

Live = JSON `{ url, pid, password? }` with **positive integer** `pid` + `kill(pid, 0)` + `GET {url}/api/info` basic auth username `opencode` returns 200 and `body.pid === file.pid`. Probe timeout 4s. URL used verbatim.

Several live, in order: `BB_OPENCODE_APP` (newest mtime **within that app**) else PATH v2 app (newest within that app) else newest overall. PATH probes **both** `opencode` and `shuvcode`; if the first is v1 (`1.x` bare or branded) and the second is v2, the v2 app wins. `--version` status must be 0. Never attach to two.

## `OpenCodeRuntime`

```ts
info(): Promise<{ version: string; url: string; appId: string | null }>
health(): Promise<OpenCodeDiscoveryHealth>
models(location: OpenCodeLocation): Promise<OpenCodeModel[]>
agents(location: OpenCodeLocation): Promise<OpenCodeAgentCatalog>
skills(location: OpenCodeLocation): Promise<OpenCodeSkill[]>
commands(location: OpenCodeLocation): Promise<OpenCodeCommand[]>
createSession(input: CreateSessionInput): Promise<SessionHandle>
openSession(sessionID: string): Promise<SessionHandle>
subscribe(sessionID: string, signal: AbortSignal): AsyncIterable<RuntimeSessionEvent>
close(): Promise<void>
```

`createSession` / `openSession` **await** SSE readiness (`server.connected`, 8s bound) before returning. Callers must `subscribe` before `prompt`. Every `SessionHandle` method asserts the runtime is not closed.

## `SessionHandle`

```ts
readonly id: string
readonly location: OpenCodeLocation
info(): Promise<OpenCodeSessionInfo> // includes tokens, cost, outcome when present
prompt(input: OpenCodePromptInput): Promise<void>
command(input: { name: string; text?: string }): Promise<void>
compact(): Promise<void>
interrupt(): Promise<void>
switchAgent(agent: string): Promise<void>
switchModel(model: OpenCodeModelRef): Promise<void>
update(patch: { title?: string; permissions?: OpenCodePermissionRule[] }): Promise<void>
fork(checkpointMessageId?: string): Promise<SessionHandle>
context(): Promise<readonly OpenCodeSessionMessage[]>
// id, type, text?, agent?, model?, skill?, finish?, tokens?, cost?, content?
// content is sanitized: thoughtSignature / password / authorization keys stripped
replyPermission(requestID: string, reply: "once" | "always" | "reject"): Promise<void>
replyForm(formID: string, answer: Record<string, string | number | boolean | string[]>): Promise<void>
setEnvironment(variables: Record<string, string>): Promise<void>
setInstructions(input: { mode: "append" | "replace"; text: string }): Promise<void>
```

### Fork (bb inclusive checkpoint)

`checkpointMessageId` is the last message of the completed turn (include it). OpenCode `before` is exclusive.

- Find that id in `context()`. Unknown → `OpenCodeUnknownCheckpointError`.
- If it is last, omit `before` (full copy).
- Else `fork({ before: next.id })`.
- Omit `checkpointMessageId` → tip fork (full copy).
- Never send HTTP `through`.

### Instructions

`setInstructions({ mode: "replace" })` throws `OpenCodeInstructionReplaceError` (no session API clears `core/instructions`).

Append: put/remove entry key `bb.instructions` (`^[a-z0-9][a-z0-9._-]*$`). Empty/whitespace text removes the entry.

### Skills / commands

Catalog ids from `skills()` / `commands()` only. `prompt.skills` is `{ id: string }[]`. Paths and unknown ids fail at the server. No `skills/configure` root registration.

### Permissions

`createSession` applies `sessionRulesForPermissionMode(permissionMode)` from `../permissions.ts`. Non-`full` **appends** `{ action:"*", resource:"*", effect:"ask" }` so agent wildcard allow cannot leak to webfetch/subagent/etc., then mode allows, then `external_directory` ask and **read+edit** `*.env` / `*.env.*` ask. No `.env.example` exemption in the overlay. Last-match-wins. Never writes `opencode.json`. Location scoping uses OpenCode's `external_directory` action, not path rewriting.

### Default agent (leave plan)

`agents(location).defaultAgentId`:

1. Last `default_agent` string on `config.get({ location })` document entries, if that id is selectable.
2. Else `build` if selectable.
3. Else first selectable agent (`!hidden` and `mode` is `primary` or `all`).
4. Else `null` (omit `agent` on create).

`agent.list` has no default flag. Do not call `config.update`.

## Events

One SSE per runtime (`client.event.subscribe({ signal })`). Demux:

- `data.sessionID === sessionID`, or `session.created` `data.id` when `sessionID` is absent
- `data.parentID === sessionID`
- transitive descendants recorded from create lineage; later child events inherit `parentID`

```ts
type RuntimeSessionEvent =
  | { kind: "native"; sessionID: string; parentID?: string; event: OpenCodeNativeEvent }
  | { kind: "resync"; sessionID: string; reason: "reconnect" | "overflow" }

type OpenCodeNativeEvent = {
  type: string
  id?: string
  created?: number
  data?: Record<string, unknown>
}
```

`kind: "native"` is a decoded vendor object with `type: string` (M0 fixtures). The runtime does not interpret vendor type names.

`kind: "resync"` is **runtime-local**, never an OpenCode event. After it, the bridge must `session.context()` and must not assume a gap-free stream.

Reconnect: backoff (250ms → 8s, abortable), new subscribe, wait for `server.connected`, **then** emit `resync`/`reconnect`. Do not resync on the disconnect itself.

Per-subscriber buffer 32. Overflow: drop, emit `resync`/`overflow`, do not grow.

`close()` / `iterator.return()`: remove subscriber + abort listener, clear child maps, abort backoff timers.

## Models (`../models.ts`)

`toAvailableModels({ models, defaultModel })`.

Wire id `providerID/id`. Every `variants[].id` is kept on `OpenCodeModel.variants` with no renaming.

`AvailableModel.supportedReasoningEfforts` only includes variant ids that are already bb `ReasoningLevel` values (`none|low|medium|high|xhigh|ultracode|max|ultra`). Other ids (`thinking`, `minimal`, …) stay on `OpenCodeModel.variants` for `switchModel({ variant })` — they are not coerced onto the closed ladder.

`runtime.models()` calls `model.list` **and** `model.default`, drops `enabled: false`, sets `isDefault` from the default id, copies `limit` for contextWindow, and keeps `defaultVariant` when the default payload has one.

`AvailableModel.routeProviderId` is omitted (it is a BB registration id, not OpenCode `providerID`).

Empty `variants[]`: `supportedReasoningEfforts` is **empty**; `defaultReasoningEffort` is `"none"` only as the required field, not a fake variant. Do not parse suffixes out of `id`. If ladder variants exist, default effort is the default model's variant when it is on the ladder, else the first listed ladder variant — never an inferred `medium`.

## Out of scope (this module)

No session delete/import, no revert, no usage windows, no auto-start, no installer, no user config mutation, no `skills/configure` roots.

## Fake runtime

`createFakeOpenCodeRuntime` is the in-memory double. Bridge unit tests use it; they do not mock `fetch`. HTTP tests use a local `http.Server`, never a global `fetch` mock.
