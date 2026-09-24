# OpenCode runtime seam

From this directory the bridge imports `plugins/provider-opencode/src/runtime/index.ts`. HTTP, SSE, and `@opencode/client` stay behind that module. One exception: `src/bridge/provider-maintenance.ts` imports `discoveryDepsFrom` and `resolveAttachedRegistration` directly from `runtime/discovery.ts` and runs the read-only `service*.json` scan itself for `provider/health` and installation status.

Pinned client: `@opencode/client@2.0.10`, imports `@opencode/client/promise` and `@opencode/client/service` only. Never `Service.ensure`, never `./effect`, never `./solid`, never `@opencode/sdk`, never `@bb/*`.

## Factory

```ts
createOpenCodeRuntime(options?: CreateOpenCodeRuntimeOptions): Promise<OpenCodeRuntime>
createFakeOpenCodeRuntime(options?: CreateFakeOpenCodeRuntimeOptions): OpenCodeRuntime
```

`createOpenCodeRuntime` attaches; it does not spawn. The env names carry no `BB_` prefix: the host daemon forks the plugin host worker (`resolveNativeRoots`) with every inherited `BB_*` variable removed, so `BB_`-prefixed names would reach the bridge but never the host worker. Order:

1. `OPENCODE_SERVER_URL` (+ optional `OPENCODE_SERVER_PASSWORD`) → explicit URL. No filesystem scan and no PATH `--version` probe.
2. Else read-only scan of `$XDG_STATE_HOME` (default `~/.local/state`) `service*.json`.

No auto-start. A runtime may be constructed while unhealthy. `health()` re-resolves and **reattaches** the HTTP client when a usable URL appears. `status: "ready"` is never returned without an attached client on a non-zero port. Session methods throw `OpenCodeRuntimeNotReadyError` until then.

The bridge keeps one runtime and calls its `health()` before model listing, thread creation/resume/fork/rename, turn dispatch, and interaction replies. Overlapping refreshes share one probe. `provider/health` also refreshes an existing runtime before reporting provider-maintenance health. A service that starts later or replaces its registration is discovered on the next such operation without restarting the bridge. Stop/discard and installation operations do not wait for discovery. Failed operations are not automatically replayed. Between requests the event pump reconnects to its current registration; if rejected credentials have already detached a session, resume it after the service is available again. `host.ts` builds a separate short-lived runtime for native roots.

`health()` first re-probes the attached registration (`kill(pid, 0)` for scanned registrations, then `/api/info` with a matching pid). Only when that fails does it rescan the state roots and PATH. While the attached registration answers, `health()` returns the health cached from the last scan: a PATH change (`installedVersion`, `pathBinaryAppId`), a changed `OPENCODE_APP`, or a newly started service of the preferred app is not picked up until the attached service stops answering or the runtime is recreated.

What `health()` does to live subscriptions:

| Discovery result | Client and subscriptions |
| --- | --- |
| `ready`, same url/pid/password | kept |
| `ready`, different url/pid/password | new client and pump; subscribers move to the new pump and get `resync`/`reconnect` once it sends `server.connected` |
| `unauthenticated` / `expired` | client dropped; subscriptions **throw** `OpenCodeUnauthenticatedError` |
| `unknown`, `not_installed`, `unsupported_version` | kept; the pump keeps reconnecting with backoff. If a client was attached and ready, session calls keep using it; only the value `health()` returns reports the status. |

While the attached pump is disconnected after a stream error or a stream that ended, `health()` reports `unknown` with `OpenCode event stream disconnected: <reason>`. `close()` ends subscriptions by throwing `OpenCodeRuntimeNotReadyError`. A subscription never ends with a clean `done` because of runtime state.

`createSession` removes the OpenCode session it just created (`session.remove`) when setting instructions or environment fails, then rethrows.

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

Glob `$XDG_STATE_HOME/<root>/service*.json`. Ignore `*.lock`, `*.bak`. Only these roots are scanned, realpath-deduped, in order:

1. `opencode/`
2. `shuvcode/`
3. `opencode-next/opencode/`
4. `<OPENCODE_APP>/` when that value is a plain name (no path separators)

Roots and registration files are checked with `lstat`, and a root's realpath must equal `<realpath($XDG_STATE_HOME)>/<root>`. A root reached through any symlink, or a symlinked `service*.json`, is skipped.

A registration needs an `http:`/`https:` `url` (else failure `url`) and a **positive integer** `pid` (else failure `pid`). A url whose host is not on this host is failure `remote` and is never probed, so its password is never sent. On this host means loopback (`localhost`, `127.0.0.0/8`, `[::1]`, IPv4-mapped `127.0.0.0/8`, `0.0.0.0`, `[::]`) or an IP literal equal to one of this host's own interface addresses (`os.networkInterfaces()`, injectable as `localAddresses`). Host names other than `localhost` are never resolved. To use a server on another host, set `OPENCODE_SERVER_URL` (+ `OPENCODE_SERVER_PASSWORD`).

Live = `kill(pid, 0)` + `GET {url}/api/info` basic auth username `opencode` returns 200 and `body.pid === file.pid`. Registration probes run concurrently with a 1.5s timeout; the explicit server probe keeps 4s. Failed probe responses have their body cancelled.

Several live, in order: `OPENCODE_APP` (newest mtime **within that app**) else PATH v2 app (newest within that app) else newest overall. Probes are awaited in that preference order; the first live one wins and the rest are aborted (failure `skipped`). PATH probes **both** `opencode` and `shuvcode` concurrently; if the first is v1 (`1.x` bare or branded) and the second is v2, the v2 app wins. `--version` status must be 0. `which` searches only the injected `env.PATH`, skips non-files, and `--version` runs with the injected `env`. Never attach to two.

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
command(input: OpenCodeCommandInput): Promise<void>
compact(): Promise<void>
interrupt(): Promise<void>
switchAgent(agent: string): Promise<void>
switchModel(model: OpenCodeModelRef): Promise<void>
update(patch: { title?: string; permissions?: OpenCodePermissionRule[] }): Promise<void>
fork(checkpointMessageId?: string): Promise<SessionHandle>
context(): Promise<readonly OpenCodeSessionMessage[]>
// id, type, text?, agent?, model?, skill?, finish?, tokens?, cost?, content?
// content is sanitized on every call: a key is stripped when its last word
// (camelCase, snake_case or kebab-case) is password / passwords / passwd / secret /
// secrets / authorization / token, or its last two words form apiKey / secretKey /
// privateKey / thoughtSignature. clientSecret and db_password are stripped;
// secretName, passwordHint and authorizationUrl are kept. Messages are not memoized
// by id: an in-progress message keeps its id while its content grows.
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

Catalog ids from `skills()` / `commands()` only. `prompt.skills` is `{ id: string }[]`. Paths and unknown ids fail at the server. `command` carries `skills`, `files` and `delivery` like `prompt`; the bridge validates both kinds of skills against the catalog before dispatch. Neither sends a message id: OpenCode assigns ids, and the bridge keys `input.accepted` by the turn the dispatch opened. No `skills/configure` root registration. `resolveNativeRoots` calls both when health is ready. Command names have no path, so the host materializes them for the daemon under `<experimental_paths.dataDir>/opencode-command-catalog/<app>/<sha256(cwd)[0:16]>`. Every segment below the data directory must be a plain directory (no symlink) and the leaf must `realpath` to itself; removals check the parent chain the same way before unlinking anything, so a swapped symlink never deletes outside the data directory. A catalog whose content hash matches the last write of this worker is not rewritten while its chain still passes that check and every expected `.md` file exists; in-place edits to those files are not detected until the command set changes or the worker restarts. Host entry `dispose` removes the directories the worker wrote. A crashed worker leaves its catalogs behind, so the first `materialize` of a worker removes every `<app>/<cwd hash>` entry it did not write; a concurrently running worker that loses its catalog this way rewrites it on its next resolve. A filesystem error while writing degrades only commands: skills still resolve and commands use the filesystem fallback. Filesystem command directories (`<app config>/commands`, then `command`, plus both under upstream `OPENCODE_CONFIG_DIR`) are the fallback when `commands()` was not fetched or could not be written. Project `.opencode/commands` and `.opencode/command` (ancestors, plural first) are static declarations and are always scanned, matching upstream's `{command,commands}/**/*.md` glob in every config directory.

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
  | { kind: "stream.error"; sessionID: string; message: string }

type OpenCodeNativeEvent = {
  type: string
  id?: string
  created?: number
  data?: Record<string, unknown>
}
```

`kind: "native"` is a decoded vendor object with `type: string` (M0 fixtures). The runtime does not interpret vendor type names.

`kind: "resync"` is **runtime-local**, never an OpenCode event. After it, the bridge must `session.context()` and must not assume a gap-free stream.

`kind: "stream.error"` is runtime-local too. The pump sends it to every subscriber once per outage, on the first failed connect attempt or the first stream that ends without an error (`OpenCode event stream ended`), with a sanitized reason. The bridge shows it as a `provider.warning` and keeps the session. A 401 is not a `stream.error`: it stops the pump and every subscription throws `OpenCodeUnauthenticatedError`.

Reconnect: backoff (250ms → 8s, abortable), new subscribe, wait for `server.connected`, **then** emit `resync`/`reconnect`. Do not resync on the disconnect itself. The backoff returns to 250ms only after a connection that stayed up for at least 10s past `server.connected`, so a server that accepts and drops keeps climbing to 8s.

Per-subscriber buffer `SUBSCRIBER_BUFFER_LIMIT` (1024) events. When an event arrives at a full queue, the queue and that event are dropped and replaced by one `resync`/`overflow`; later events queue normally. A consumer that keeps falling behind sees one `resync`/`overflow` per overflow.

`close()` / `iterator.return()`: remove subscriber + abort listener, clear child maps, abort backoff timers.

How a subscription ends:

| Cause | Iterator |
| --- | --- |
| Caller aborts its signal or calls `return()` | clean `done` |
| 401 on the stream (fatal) | throws `OpenCodeUnauthenticatedError` |
| `health()` finds `unauthenticated` / `expired` | throws `OpenCodeUnauthenticatedError` |
| `runtime.close()` | throws `OpenCodeRuntimeNotReadyError` |
| Transient stream error or clean SSE end | does not end: `stream.error` once, then `resync`/`reconnect` after the next `server.connected` |
| `health()` attaches a different registration | does not end: moves to the new pump, then `resync`/`reconnect` |

### Bridge handling

- `stream.error` → `provider.warning` "OpenCode event stream disconnected; reconnecting". The session stays attached.
- `resync` (either reason) → `session.context()`, then `translator.reconcileAfterResync`: open tool items close as `completed`, open text and compaction items close, the last context message becomes the checkpoint id, and an open turn closes as `completed`. Events dropped by the outage or the overflow are not replayed. A turn still running in OpenCode reopens on its next event.
- A `durable.seq` gap on one aggregate runs the same reconcile for that session before the event's own deltas.
- A handler that throws while applying a native event → `provider.error` scoped to the thread or turn, then one extra `resync`. If that extra resync fails, it is only logged and not retried.
- A `resync` from the pump (reconnect or overflow) or from a resubscribe whose `context()` read fails → `provider.error` scoped to the thread or turn, not retried.
- A subscription that throws → pending accepts settle as a zero-work `failed` turn, an open turn gets `provider.error` and a `failed` `turn.boundary`, otherwise a thread-scoped `provider.error`. `OpenCodeUnauthenticatedError` also sends `provider/recovery { authRequired }`. The session is detached, so a later `turn/start` fails with `No active OpenCode session`.
- A subscription that ends with `done` while the session is open → resubscribe with backoff (250ms → 8s, reset after an event arrives) and apply one `resync` before the next event.

## Models (`../models.ts`)

`toAvailableModels({ models, defaultModel })`.

Wire id `providerID/id`. Every `variants[].id` is kept on `OpenCodeModel.variants` with no renaming.

`AvailableModel.supportedReasoningEfforts` only includes variant ids that are already bb `ReasoningLevel` values (`none|low|medium|high|xhigh|ultracode|max|ultra`). Other ids (`thinking`, `minimal`, …) stay on `OpenCodeModel.variants` for `switchModel({ variant })` — they are not coerced onto the closed ladder.

`runtime.models()` calls `model.list` **and** `model.default`, drops `enabled: false`, sets `isDefault` from the default id, copies `limit` for contextWindow, and keeps `defaultVariant` when the default payload has one.

`AvailableModel.routeProviderId` is omitted (it is a BB registration id, not OpenCode `providerID`).

Empty `variants[]`: `supportedReasoningEfforts` is **empty**; `defaultReasoningEffort` is `"none"` only as the required field, not a fake variant. Do not parse suffixes out of `id`. If ladder variants exist, default effort is the default model's variant when it is on the ladder, else the first listed ladder variant — never an inferred `medium`.

## Out of scope (this module)

No session delete/import, no revert, no usage windows, no auto-start, no installer, no user config mutation, no `skills/configure` roots.

## Recorded wire facts

From live captures against `@opencode/client@2.0.10` (shuvcode 2.0.8) and upstream `@opencode/cli@2.0.11`. The sanitized captures are `../fixtures/events-owned.sanitized.json`, `../fixtures/child-events.sanitized.json` and `../fixtures/event-types.json`.

- **Registrations.** Latest-channel binaries write unkeyed `$XDG_STATE_HOME/<app>/service.json`. Keyed `service-<sha1(channel)>.json` files are legacy channel names, so the scan globs `service*.json`. `Service.discover()` without `file` reads only `opencode/service.json` and cannot see shuvcode. `Service.ensure` SIGTERMs, SIGKILLs and deletes a registration on a version mismatch or timeout, which is why it is never called.
- **Auth.** Unauthenticated `GET /api/info` is 401 with an empty body. Basic auth username is always `opencode`, also on shuvcode. The password is re-read from the registration and never persisted.
- **Client shapes.** `session.create` returns `SessionInfo`, not `{ data }`. `event.subscribe({ signal })` yields decoded events. Permission replies go through `client.permission.reply({ sessionID, requestID, decision })`, while the `permission.replied` event carries `reply`. `session.form.reply` takes `answer`, not `answers`. `model.list`, `model.default` and `agent.list` are location-scoped (`{ location: { directory } }`); a directory outside a configured project can return zero models.
- **SSE.** One process-wide stream, live only, no replay and no client reconnect. A late subscriber gets only `server.connected`. Child sessions carry `data.parentID` on `session.created` and inherit the parent's `metadata` and `permissions`.
- **Envelopes.** Most session events carry `durable: { aggregateID, seq, version }`. `permission.asked`, `permission.replied`, `form.created`, `form.replied`, `session.usage.updated` and `session.text.delta` do not. `session.tool.called.data.state.thoughtSignature` is sensitive; `context()` and `unhandled` raw payloads strip it. Token usage lives on `Session.Info.tokens` as `{ input, output, reasoning, cache: { read, write } }`; the key `tokens` is not a secret.
- **Recorded event names** are in `event-types.json`. The translator maps or ignores every recorded name, and also maps `session.execution.failed` and `session.execution.interrupted`, which settle turns. Never recorded: `session.idle`, `session.reasoning.*`, `session.tool.failed`, `session.tool.progress`, `session.tool.input.delta`, `session.compaction.failed`, `form.cancelled`, `session.forked`. Those stay `unhandled` until a capture shows their shape.
- **Instructions.** No `instructions` field on session create or update. `session.instructions.entry.put` keys must match `^[a-z0-9][a-z0-9._-]*$` (a `/` is a 400). Entries are combined with `AGENTS.md`; putting `core.instructions` adds a second entry and does not replace the ambient one.
- **Skills.** No session API registers a skill root. `prompt.skills[].id` and `session.skill` accept only catalog ids; unknown ids and filesystem paths are rejected.
- **Commands.** `CommandInfo` is `{ name, description? }` with no path. An unknown name is `CommandNotFoundError`.
- **Fork.** `before` is exclusive and must be a `msg_` id. Raw HTTP accepts `through`, but a capture still contained later messages, so inclusive truncation is unproven.
- **Variants.** Some providers expose effort as separate model ids (`…-high`, `…-low`) with `variants: []`. Switching effort there is a different `ModelRef.id`.

## Fake runtime

`createFakeOpenCodeRuntime` is the in-memory double. Bridge unit tests use it; they do not mock `fetch`. HTTP tests use a local `http.Server`, never a global `fetch` mock.

## Companion status

`src/companion-status.ts` reads companion status for a machine. It does not use `SessionHandle.rpc` (that call is bound to a session Location). `src/companion-location-rpc.ts` opens its own `@opencode/client` from `resolveAttachedRegistration` and calls `client.rpc.call` plus `client.plugin.list` with no session and no directory, so the engine uses its default Location. Explicit `OPENCODE_SERVER_URL` mode uses the same calls and does not scan the filesystem for the companion.

`hello` is sent as `{ client, protocol: { min: 1, max: 1 } }`. A companion that rejects that input is retried with `{}`. A milestone-1 hello fills package, protocol range, install path/digest, instances, richFailures, and limits. A 0b hello (`protocol`, `version`, `generation`, `features` only) leaves versions, package, install, and instances unknown; overlap is still computed from the legacy `version` number when that is the only version field. `rpc.unavailable` / `RPC is unavailable: bb.tools.v1` is "not installed". Any other hello failure is not treated as absence.

When `instances > 1`, or the plugin list has more than one companion-shaped spec (`opencode-bb-tools`, `bb.tools`, `bb.tools.v1`, or a spec string containing `opencode-bb-tools`), status sets `duplicates` and includes those specs. Attachment failure on duplicates is bridge work, not this probe.

The host entry method is `readCompanionStatus`. The server RPC is `companionStatus({ machineId })`. CLI: `bb opencode tools status --machine <id> [--json]`.

`bbToolsRequired` (default false) is a provider setting. `parseOpenCodeProviderOptions` already copies it onto `AppliedSessionKnobs.bbToolsRequired`. The bridge does not read it yet. Intended behavior, once wired: if the flag is true and hello is absent, fail the turn with `bbToolsRequiredSetupMessage` before prompting. Do not emit the dropped-tools warning on that path. If the flag is false, keep native-only behavior and the absent-companion warning. An out-of-range companion already fails the turn regardless of the flag.
