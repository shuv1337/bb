# PLAN: First-class OpenCode v2 provider

Status: spec, revised 2026-09-20 after checking claims against this host, `@opencode/client@2.0.10`, `@opencode/sdk@2.0.10`, and the published v2 OpenAPI (§0). §9 items 1, 2 and 7 are now firm. Do not implement until the rest of §9 is resolved.

This is the design for a true OpenCode v2 provider: bb becomes an OpenCode **client of the v2 HTTP API via `@opencode/client`**, not a guest of `opencode acp`. `@opencode/sdk` is not used (it is the server; see §0). ACP protocol 1 stays as a compatibility lane for v1 binaries and for hosts that cannot run a v2 service.

Sources of truth used while writing:

- OpenCode v2 docs: [API](https://opencode.ai/v2/docs/api/), [client](https://opencode.ai/v2/docs/build/client/), [SDK](https://opencode.ai/v2/docs/build/sdk/), [ACP](https://opencode.ai/v2/docs/cli/acp/), [permissions](https://opencode.ai/v2/docs/permissions/), [agents](https://opencode.ai/v2/docs/agents/), [compaction](https://opencode.ai/v2/docs/compaction/), [snapshots](https://opencode.ai/v2/docs/snapshots/), [plugins](https://opencode.ai/v2/docs/build/plugins/), [troubleshooting](https://opencode.ai/v2/docs/troubleshooting/). OpenAPI: https://opencode.ai/v2/openapi.json (136 operations; the HTTP surface is marked experimental).
- bb provider contract: `docs/provider-plugin-api.md`, `docs/provider-bridge-protocol.md`, `packages/plugin-sdk/src/backend-contract.ts`, `examples/plugins/echo-provider/`.
- Current OpenCode lane: `plugins/provider-acp/src/known-agents.ts` (`acp-opencode`, `opencode acp`), `packages/provider-bridge-acp/`.
- Forks in the same protocol family: Latitudes-Dev/shuvcode (`Global.app = "shuvcode"`, `docs/shared-service.md` in that repo). Same v2 HTTP API, different XDG roots and binary.

## 0. Verification findings (2026-09-20)

Checked on this host and against published packages. Each item changed a decision below.

| Claim in the first draft | What is actually true | Consequence |
| --- | --- | --- |
| Upstream registers at `~/.local/state/opencode/service.json` | This host has `~/.local/state/opencode/service-edee9402….json` (keyed by a sha1) plus `.lock` files. The `@opencode/client@2.0.10` `Service.fallback()` still reads `opencode/service.json`. The keyed file is stale: pid dead, `version: "0.0.0-next-15591"`. | Discovery must glob `service*.json` per app root and verify liveness by `/api/info` `pid` match, not by filename or by parsing the version string (D3). |
| `GET /api/status` is a health endpoint | 404. `GET /api/info` (`server.info`) returns `{ version, pid, urls, paths }` and needs auth (401 without). | `/api/info` is the only identity probe. A 404 on `/api/info` is how `@opencode/client` itself decides "not v2" (D4). |
| `opencode` on PATH means upstream | `~/.local/bin/opencode → shuvcode`; `opencode --version` prints `shuvcode v2.0.8-shuv.1`. | App id comes from `--version` output / registration, never from the binary name (D3 step 5). |
| `Service.ensure()` is a discover-then-start helper | It also SIGTERMs (then SIGKILLs) a registered server it judges incompatible or unresponsive and `rm`s its registration file. It only passes `OPENCODE_PTY_HANDOFF` to the child; the child picks its own registration filename. | `ensure` is never called against a file bb did not choose. Scanning uses read-only `Service.discover({ file })` or a direct `/api/info` fetch. M0: isolated latest-channel `shuvcode` and `@opencode/cli-linux-x64` both write unkeyed `$XDG_STATE_HOME/<app>/service.json` (keyed `service-<sha1>.json` is legacy `sha1(channel)`). Auto-start stays off (§9.8). |
| Registration URL is loopback | shuvcode registered `http://100.126.224.77:4096` (tailnet). | Use the registration URL verbatim; the daemon must not assume `127.0.0.1` (D3, §8). |
| `@opencode/sdk` `OpenCode.create()` is an embeddable runtime | `@opencode/sdk@2.0.10` depends on `@opencode/server`, `@opencode/core`, `@opencode/plugin`, `effect`. It is the whole server. | No embedded SDK adapter in the host artifact. Dropped (D2, D7, §9.7). |
| `@opencode/client` is a plain HTTP client | deps `@opencode/schema`, `@opencode/protocol`; peer deps `effect@4.0.0-rc.112`, `solid-js`. Entrypoints `.`/`./promise`/`./service` exist. | Import only `@opencode/client/promise` + `@opencode/client/service`. M0 esbuild of those two entrypoints (2.0.10 and 2.0.11) contains zero `effect`, `solid-js`, or `@opencode/schema` references (`recordings/bundle-check.json`). D9 fetch-client fallback is not required. |
| Health can report `needs_update` / `error` | `providerHealthSchema.status` is `ready \| not_installed \| unauthenticated \| expired \| unsupported_version \| unknown`. | v1-only → `unsupported_version`; dead registration → `unknown` + `statusMessage` (D4, 4.6). |
| An `agent` field needs a daemon bump | `bridgeExecutionOptionsSchema.providerOptions` already rides the wire and `deriveProviderOptions(ctx)` fills it from `settings` + `promptMode`. `PluginProviderOptionsContext` has no per-thread user input, so a `--agent` CLI flag still needs a core slot. | M2 agent subset confirmed daemon-free. M4 moves to its own plan (D5, §9.2). |
| Archive route may exist | 136 operationIds; no `session.archive`. Present and confirmed: `session.create/get/fork/prompt/command/compact/interrupt/update/switchAgent/context/environment/remove/move`, `session.permission.reply`, `session.form.list/create/get/cancel/reply`, `session.inbox.list/update/cancel`, `session.revert.stage/commit/clear`, `model.list/default`, `agent.list`, `skill.list`, `command.list`, `event.subscribe`, `experimental.session.wait/stats/skill/import/export`, `permission.saved.list/remove`, `experimental.mcp.add/remove/connect/disconnect`. | `supportsThreadArchive: false` is firm. `experimental.mcp.*` is location-global, so D7 stands. |
| Event payload shape | `V2EventEncoded` is `{ type: "string", contentMediaType: "application/json" }`. Client exports `EventSubscribeOutput as OpenCodeEvent`. | Recorded fixtures are in `plugins/provider-opencode/recordings/`. The translator switches only on names in `event-types.json`, plus the contract settle trio `session.execution.succeeded\|failed\|interrupted` until `session.idle` is recorded. It does not switch on or ignore-list `session.compaction.failed`, `session.reasoning.*`, `session.tool.failed`, `session.tool.progress`, or `session.tool.input.delta`. |
| `GET /api/command` returns a filesystem path | `@opencode/client@2.0.10` `CommandInfo` is name plus optional description only (`recordings/client-signatures.json`, `recordings/mapping-blockers.sanitized.json`). | `resolveNativeRoots` still prefers that list when the service is up and materializes each safe name as markdown, because the native-root contract is path-based. Filesystem `commands/` and legacy `command/` directories are the fallback when the list was not fetched. |

## 1. Goal

A user with OpenCode v2 on a host picks **OpenCode** in bb and gets the same agent the TUI would: native sessions, agents, models, variants, skills, commands, permissions, compaction, checkpoint fork, resume across bridge restarts, context usage, forms, and integrations.

bb does not pretend OpenCode is a generic ACP process. The host artifact is an OpenCode client. The vendor dialect is the v2 event stream and resource APIs. The bb dialect is still grammar-v3 `thread/delta`.

Success looks like Codex/Claude/Pi: own plugin, own bridge, own declaration. Not another row in `KNOWN_ACP_AGENTS`.

## 2. Current behavior

`acp-opencode` is an ACP guest:

| Fact | Where | What it does |
| --- | --- | --- |
| Launch | `plugins/provider-acp/src/known-agents.ts` | `opencode acp` (v2 docs: private server, ACP protocol **1**, no shared service) |
| Wire | `packages/provider-bridge-acp/src/bridge/agent-connection.ts` | `ACP_PROTOCOL_VERSION = 1` |
| Dialect | `packages/provider-bridge-acp/src/dialect.ts` | Command stdout/exitCode normalization only |
| Models | ACP `configOptions` / `session/set_config_option` | Heuristic thought_level mapping |
| Agents | Docs in `docs/configuration.md` | Explicitly **not** selected |
| Fork | Declaration `tip` | No rewind. v2 HTTP `session.fork({ before })` is unused |
| Resume | ACP `session/load` or fresh `session/new` | Handshake `sessionRestore: false` |
| Compact | Prompt `"/compact"` | Not `POST /api/session/{id}/compact` |
| Skills | Filesystem roots + text dump into instructions | Not `GET /api/skill` / prompt `skills[]` |
| Tools | Spawned MCP child | Not OpenCode tool/plugin transforms |
| Steer | `queue` | v2 inbox has `"steer"` \| `"queue"` |
| Usage / install | Not declared | Health is PATH probe only |

Open issues this design is meant to close rather than paper over: #1093 (agents), #3899 / #3620 (variants vs thought_level), #3499 (attachments), #3380 (native rewind + files), #2471 (empty MCP at session/new), #1957 (OpenCode Go usage).

## 3. Decisions

### D1. New provider id `opencode`, new plugin `provider-opencode`

Do not stretch `acp-opencode`. Provider ids are durable on thread rows (`PluginProviderDeclaration.id`). A native bridge is a different executable contract.

- Plugin id: `provider-opencode` (same pattern as `provider-pi` / `provider-codex`).
- Provider id: `opencode`.
- Family: omit (it is not ACP).
- Visibility: `"installed"` until health reports a v2 service.
- `acp-opencode` remains in `provider-acp` for v1 binaries and as an escape hatch.

Existing `acp-opencode` threads stay on ACP. No silent id rewrite.

### D2. bb is an OpenCode client. OpenCode owns the agent loop.

The deep module is an **OpenCode runtime handle** behind a small interface. The bb provider bridge is an adapter from that handle onto the existing Provider Bridge Protocol. Callers of the bridge never see HTTP, SSE, service.json, or SDK hosts.

```
bb server  (policy, picker, instructions, dynamicTools)
  → daemon (artifact worker, env allowlist, assembler)
    → provider-opencode bb.host
         experimental_providerBridge
           OpenCodeRuntime          ← the seam
             SharedService adapter  ← discover any healthy v2 registration, then @opencode/client
             ExplicitUrl adapter    ← BB_OPENCODE_SERVER (+ BB_OPENCODE_PASSWORD)
             FakeRuntime            ← tests only, in-memory
         host RPC: resolveNativeRoots, maybe probeService
```

There is no embedded adapter. `@opencode/sdk` is the full server (§0), so "embed" would mean bundling OpenCode into the bb host artifact and running a second server against the user's db. Both adapters are HTTP clients; they differ only in how the endpoint is found.

Division of labor stays the bb one in `docs/provider-bridge-protocol.md`:

- Bridge knows the OpenCode dialect (events → `thread/delta`).
- Runtime knows the timeline (ids, turns).
- Server owns product policy.
- Daemon owns host-local process/env. It does **not** need to learn OpenCode.

A new plugin + bridge does **not** bump `HOST_DAEMON_PROTOCOL_VERSION` (currently 215 in `packages/host-daemon-contract/src/protocol.ts`). Bridges version with the plugin. Nothing in this plan adds a thread-start field; the per-thread `agent` slot that would is a separate plan (D5).

### D3. Default runtime: attach to whatever v2 service is already running

OpenCode v2 is client/server. Any compatible TUI or `serve --service` process is a client of one background server. First-class means bb is another client of **that already-running server**, not a second OpenCode spawned under the upstream binary name.

`@opencode/client/service` `Service.ensure()` is **not** a discovery helper. Verified in `@opencode/client@2.0.10` `dist/promise/service.js`:

- It reads exactly one file (`options.file`, default `$XDG_STATE_HOME/opencode/service.json`).
- If that file's server answers `/api/info` with a different `pid`/`version`, or times out three times, it **SIGTERMs then SIGKILLs the pid and `rm`s the file**, then spawns `options.command` (default `opencode serve --service`).
- On this host the upstream root does not even contain `service.json`; it contains `service-<sha1>.json` (stale, dead pid) and `.lock` files, while shuvcode registers at `~/.local/state/shuvcode/service.json` with a **tailnet** URL. Default `ensure()` would spawn `opencode` — which here is a symlink to `shuvcode` — with no coordination against the running fork.

**Discover read-only. Never let the client library kill anything. Start only if nothing compatible is healthy, and only via a file/command pair bb chose.**

1. Explicit URL: `BB_OPENCODE_SERVER` (+ optional `BB_OPENCODE_PASSWORD`; username is always `opencode`, matching `Service.headers`). Probe `/api/info`; do not scan.
2. Scan registrations. For each app root under `$XDG_STATE_HOME` (default `~/.local/state`), glob `service*.json` (both `service.json` and `service-<sha1>.json` shapes; ignore `*.lock`, `*.bak`). Roots, in order, de-duplicated by realpath:
   - `opencode/` — upstream
   - `shuvcode/` — Latitudes-Dev/shuvcode (`Global.app = "shuvcode"`; see that repo's `docs/shared-service.md`)
   - `opencode-next/opencode/` and `*/opencode/` — channel layouts
   - `*/` — other `Global.app` forks
   A registration is **live** only if: JSON has `url`, `pid`, `password?`; `process.kill(pid, 0)` succeeds; `GET {url}/api/info` with basic auth returns 200 and a body whose `pid` equals the file's `pid`. Do this with `Service.discover({ file })` (read-only) or a direct fetch — **never `Service.ensure`** during scanning. Do not parse version strings to decide v2-ness; a 200 on `/api/info` is the v2 predicate (v1 returns 404, the same test the client uses).
3. Compatibility is the **HTTP contract**, not the process name. `2.0.8-shuv.1` is v2. A v1 `opencode` binary on PATH is irrelevant if a v2 service is already up.
4. If several registrations are live: prefer `BB_OPENCODE_APP` if set (`opencode` | `shuvcode` | other app id, matched against the state root dir name); else the app whose binary is on PATH and whose `--version` prints that app name (`shuvcode v2.0.8-shuv.1` → `shuvcode`, even when invoked as `opencode`); else the newest registration mtime. Never attach to two.
5. If none are live, auto-start is **gated behind M0 item 3** (see §7). When enabled: pick the app by `--version` output of the PATH binary, then `Service.ensure({ file, command, version })` with `file` = the registration path that binary actually writes and `command: [<binary>, "serve", "--service"]`. Until M0 shows which filename `serve --service` writes (`service.json` vs `service-<sha1>.json`), M1 ships with **no auto-start**: health says `unknown` with `statusMessage: "run `<app> serve --service` or open the <app> TUI"`.
6. Auth headers come from that registration (`Service.headers({ url, auth: { type: "basic", username: "opencode", password } })`). Do not invent tokens. Do not log the password field. Do not copy the password into bb settings or thread rows; re-read the registration on every bridge start.
7. Use the registration `url` verbatim. It may be a non-loopback address (tailnet here). The daemon's egress rules must allow it; do not rewrite to `127.0.0.1`.

Once attached, XDG config/state/data roots follow that service's `Global.app` (`~/.config/shuvcode`, `~/.local/share/shuvcode`, …). Do not set `OPENCODE_CONFIG_DIR` on a shuvcode host (their docs forbid it). Skill/command filesystem fallbacks in D8 use those roots; live `GET /api/skill` already sees whatever the attached server loaded.

```ts
import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/service"

const endpoint = await discoverV2Service() // read-only scan; never Service.ensure here
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
})
```

Why this is the default:

- Credentials and integrations already live on that server.
- Location config, skills, agents, MCP, plugins load the same way that TUI does.
- Sessions persist in **that** app's db independently of the bb bridge → real `sessionRestore`.
- One agent loop. Starting a second `opencode` next to shuvcode is the failure mode.

Isolation rules so bb does not ransack the TUI (upstream or shuvcode):

1. bb **creates** sessions (`session.create`) with `metadata.bbThreadId`. It never attaches to a session it did not create unless the user imports one.
2. Event subscription is process-wide; the bridge **filters** on `sessionID`.
3. bb never writes the user's `plugins`, `mcp.servers`, or global `permissions` arrays.
4. bb never `session.remove`s on thread delete unless a plugin setting opts in.
5. Title updates are namespaced (`bb: …` or the bb thread title) so the TUI list stays readable.

Escape hatches, same interface:

| Adapter | When | How |
| --- | --- | --- |
| Shared service | Default | Read-only discovery of any live v2 registration; auto-start of the matching app only after M0 item 3 |
| Explicit URL | Remote, CI, tailnet, or a user who wants a private `serve` | `BB_OPENCODE_SERVER` + `BB_OPENCODE_PASSWORD` |
| Fake runtime | Unit and conformance tests | In-memory `OpenCodeRuntime`; no HTTP |

The "isolated" use case (private OpenCode process per bb) is served by the user running `<app> serve --port … --password …` and setting the explicit URL. bb does not ship an embedded server (§0).

M0 must prove: (a) discovery finds the running shuvcode registration and talks `/api/info` without spawning anything; (b) which registration filename `serve --service` writes for each app, so step 5 can be enabled safely; (c) that `@opencode/client/promise` bundles into the host artifact without pulling `effect` at runtime.

### D4. Use the HTTP/SDK surface, not ACP, for every capability we claim

Capability mapping. Endpoints from the v2 OpenAPI `operationId`s.

| bb surface | OpenCode v2 | Notes |
| --- | --- | --- |
| `provider/health` | `server.info` (`GET /api/info`; there is no `/api/status`) | Live discovered service → `ready` (binary name does not matter). Only a v1 binary on PATH and no live registration → `unsupported_version` with install action. No v2-capable binary and no registration → `not_installed`. Registration present but pid dead / `/api/info` failing → `unknown` with `statusMessage` naming `<app> serve --service`. These are the only values `providerHealthSchema.status` accepts (`ready`, `not_installed`, `unauthenticated`, `expired`, `unsupported_version`, `unknown`); there is no `needs_update` or `error`. |
| `provider/installation/*` | Installer for the **chosen app** | Do not run the upstream curl installer on a shuvcode host. Daemon runs the plan. Same pattern as Pi/Codex. |
| `model/list` | `model.list` + `model.default` at `location.directory = cwd` | **`models.scope: "workspace"`** (project `opencode.json` changes the catalog). ACP wrongly used `host`. |
| Model id wire format | `Model.Ref` `{ providerID, id, variant? }` | Persist as `providerID/id` plus variant in reasoning/service-tier, **not** ACP `provider/model` string heuristics. |
| Reasoning | `Model.Info.variants[]` | Map known variant ids onto bb's ladder (`none`…`ultra`). Unmapped variants stay as labelled efforts from `model/list` (fixes #3899 / #3620). |
| Agent | `agent.list` / `session.switchAgent` / `session.create({ agent })` | Primary+`all`, not `hidden`, not subagent-only. See D5. |
| Plan composer action | `switchAgent("plan")` | `deriveProviderOptions` sees `promptMode: "plan"`. Leaving plan switches back to `build` or `default_agent`. |
| `thread/start` | `session.create({ location, agent, model, title, metadata, permissions })` | `providerThreadId = session.id` (`^ses`). |
| `thread/resume` | `session.get` + `event.subscribe` | If 404, fail the resume. Do not silently create. `sessionRestorable: true`. Handshake `sessionRestore: true`. |
| `thread/fork` | `session.fork({ before })` | `before` is the OpenCode `msg_` at the checkpoint. **`fork: "checkpoint"`** — rewind works. Tip fork omits `before`. |
| Native file rewind | `session.revert.stage` / `commit` / `clear` | Follow-on for #3380. Snapshots restore files in the Location. bb fork today clones conversation; OpenCode revert undoes files in place. Do not pretend they are the same. |
| `turn/start` | `session.prompt({ text, files, skills, agents, delivery, id })` | `delivery: "steer"` for live turns (handshake `steerMode: "inject"`). Queue only when the session is busy and bb asked to queue. Idempotent `id: msg_…` when retrying. |
| Attachments | `PromptInput.FileAttachment` | Fix #3499: real file parts, not ACP content-block guesswork. |
| bb / OpenCode skills | Prompt `skills[]` + `experimental.session.skill` | Composer lists `GET /api/skill`. Selected bb skills become skill attachments, not a SKILL.md path essay in instructions. |
| Slash commands | `GET /api/command` + `session.command` | Declare `experimental_nativeCommandRoots` for `.opencode/commands` and resolve extras from the API. |
| Compact | `session.compact` | Structured RPC. Follow `session.compaction.*` events. Do not send `"/compact"` as text. |
| Interrupt | `session.interrupt` | `thread/stop` intent `interrupt`. |
| Rename | `session.update({ title })` | `supportsThreadRename: true`. |
| Archive | **not in the public HTTP list** | `Session.Info.time.archived` exists; no archive route found. Declare `supportsThreadArchive: false` until OpenCode documents one. |
| Steer | `session.prompt({ delivery: "steer" })` / inbox update | Better than ACP queue-cancel. |
| Permissions | `session.create/update.permissions` + `session.permission.reply` | Map bb modes → `Permission.Ruleset`. Asks become `interaction/request`. Reply `once` / `always` / `reject`. |
| Forms / questions | `session.form.*` + permission action `question` | `supportsNativeUserQuestion: true` so `ask-user-question` does not double-register. |
| Usage on timeline | `TokenUsage.Info` on session + assistant messages | `usage` + `contextWindow` deltas. |
| Subscription usage | `experimental.session.stats` + integrations | Best-effort for #1957 (OpenCode Go). If the API cannot produce windows, keep `maintenance.usage: false` rather than lie. |
| Context | `session.context` | Hydrate resume; do not replay as new turns. |
| Subagents | Child sessions (`parentID`) | `delegation` items + child `turn.open` with `parentRef`. |
| Env | `session.environment` | Map `contributedEnv` here, not ACP env spawn. |
| Wait | `experimental.session.wait` | Optional; event stream is the primary settle signal. |

Do **not** drive the TUI, PTY, persistent PTY, or `opencode run` from this provider. Those are other clients.

### D5. OpenCode agents are first-class, not fake models

An OpenCode agent (`build`, `plan`, custom primary) is a session profile: system prompt, permissions, optional model. It is not a bb model id. #1093 stays open until this is selectable.

Two layers:

**Ship without a daemon bump (M2) — confirmed against the wire:**

`bridgeExecutionOptionsSchema.providerOptions: Record<string, unknown>` already travels on `thread/start`, `thread/resume`, `thread/fork` and `turn/start`, and `deriveProviderOptions(ctx)` fills it from `ctx.settings` and `ctx.promptMode`. The bridge reads `options.providerOptions.agent`.

- Default agent = OpenCode `default_agent` (usually `build`), i.e. omit `agent` on `session.create`.
- Composer `plan` → `deriveProviderOptions` returns `{ agent: "plan" }` → `switchAgent("plan")` on the live session. Leaving plan returns `{ agent: settings.defaultAgent ?? null }` → switch back.
- Plugin setting `defaultAgent` (string, non-secret) for a user override; validated against `agent.list` at thread start, unknown → fail the command naming the agent, do not fall back silently.
- CLI: `bb plugin config provider-opencode set defaultAgent reviewer`.

**Per-thread agent choice (M4) — not in this plan:**

`PluginProviderOptionsContext` carries `threadId`, `projectId`, `model`, `permissionMode`, `promptMode`, `settings` and nothing the user typed per thread. So `bb thread spawn --agent reviewer` needs a core slot (thread-start field + CLI flag + SDK field), which bumps `HOST_DAEMON_PROTOCOL_VERSION` and touches `docs/api_to_audit.md`. That is a cross-provider change (Cursor modes, Claude agents, Codex profiles want the same slot) and gets its own plan. This plan stops at settings + plan action. A web-only agent control in `app.tsx` is not shipped either: AGENTS.md requires CLI + SDK parity, and a `bb.settings` control already gives all three surfaces the same knob.

Do not encode agents into model ids (`anthropic/claude#high@build`). Model and agent are independent on `Session.Info`.

### D6. Permission modes are a bb overlay on OpenCode rulesets

OpenCode evaluates an ordered `Permission.Ruleset`; last match wins; default is `ask`. bb modes are a closed enum (`accept-edits` | `auto` | `full`).

Map at `session.create` / `session.update` as **session-scoped rules appended after the agent's rules** (`ctx.permission.rules` in the plugin API; HTTP is `session.update.permissions`):

| bb mode | Session ruleset intent |
| --- | --- |
| `accept-edits` | `edit` allow inside the Location; `shell` ask; `external_directory` ask; `.env` ask |
| `auto` | `edit` + `shell` + `read`/`glob`/`grep` allow inside the Location; `external_directory` ask; `.env` ask |
| `full` | `action: "*", resource: "*", effect: "allow"` |

Never write these into `opencode.json`. They are per bb thread.

`approvalEnforcedBy: "runtime"` for the closed subjects we can classify (`file_change`, `command`, `tool_use`). OpenCode `ask` still arrives as events; the bridge raises `interaction/request`; the runtime auto-decides when the mode says so, otherwise the user answers. Reply with OpenCode's `once` / `always` / `reject`. `always` is OpenCode-durable and project-scoped — document that in the plugin skill.

Handshake `steerMode: "inject"`.

### D7. bb plugin tools

OpenCode's native tools (read/edit/shell/skill/subagent) stay OpenCode's. bb `dynamicTools` are the problem: MCP on the shared service is **location-global** (`PUT /api/experimental/mcp/{server}`), and a plugin transform only exists inside that server.

Rules:

1. Ask-user-question is **not** injected (`supportsNativeUserQuestion: true`). Use OpenCode forms + `question`.
2. Other bb tools: **not delivered in v1.** The only HTTP routes are `experimental.mcp.add/remove/connect/disconnect` (`PUT /api/experimental/mcp/{server}`), which mutate the attached server's location-global MCP list; a `ctx.mcp.transform` hook only exists inside an OpenCode plugin running in that server, and with no embedded adapter (§0) bb has no process to host one. Declare the gap: threads on `opencode` do not see bb `dynamicTools`. The bridge logs one warning per thread naming the dropped tool ids.
3. Do not add a bb OpenCode plugin to `opencode.json` automatically, and do not call `experimental.mcp.add`.
4. Follow-on (own plan): an opt-in `bb-opencode` OpenCode plugin the user adds to their config, which connects back to a bridge-local MCP proxy (same idea as `packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts`). Or wait for OpenCode session-scoped MCP.

The Runtime seam still earns its keep here: if OpenCode grows a per-session tool route, only the adapter changes.

### D8. Skills and commands come from the API, with filesystem fallback

Declared roots (composer offline, same layout v2 still documents):

- user: `.config/<app>/skills` where `<app>` is the discovered `Global.app` (`opencode` or `shuvcode`), plus `.claude/skills`, `.agents/skills`
- project: `.opencode/skills`, `.opencode/commands`, `.claude/skills`, `.agents/skills` with `ancestors: true`
- `recursive: true` on skill roots (v2: `SKILL.md` at any depth)

Host `resolveNativeRoots` **prefers** `GET /api/skill` and `GET /api/command` at the workspace location when the service is up, so config `skills` arrays, HTTP catalogs, and nested IDs appear. Filesystem scan is the fallback when the service is down.

bb-injected skills use prompt `skills[]` / skill activation, not an instruction appendix of absolute paths.

### D9. Zero first-party privilege

`plugins/provider-opencode` imports only `@get-bb/plugin-sdk` (and `/provider-bridge`, `/host`, `/app`), `zod`, node builtins, and `@opencode/client/promise` + `@opencode/client/service`. Never `@opencode/sdk`, never the `./effect` or `./solid` entrypoints (they pull `effect@4.0.0-rc.*` / `solid-js` peers). `public-sdk-only.test.ts` as in echo-provider and provider-acp. No `@bb/*` in plugin runtime files.

If M0 item (c) shows the promise client still drags `effect` into the host bundle, replace it with a plugin-private `fetch` client over the ~25 operations in D4, typed from the pinned OpenAPI. That is less code than a peer-dependency fight in the host artifact.

## 4. Architecture

### 4.1 Module and seam

**Module:** OpenCode runtime (plugin-private).

**Interface** (illustrative; names live under `plugins/provider-opencode/src/runtime/`):

```ts
interface OpenCodeRuntime {
  info(): Promise<{ version: string; url?: string }>
  models(location: { directory: string }): Promise<OpenCodeModel[]>
  agents(location: { directory: string }): Promise<OpenCodeAgent[]>
  skills(location: { directory: string }): Promise<OpenCodeSkill[]>
  commands(location: { directory: string }): Promise<OpenCodeCommand[]>
  createSession(input: CreateSessionInput): Promise<SessionHandle>
  openSession(sessionID: string): Promise<SessionHandle>
  subscribe(sessionID: string, signal: AbortSignal): AsyncIterable<OpenCodeEvent>
  close(): Promise<void>
}

interface SessionHandle {
  readonly id: string
  prompt(input: PromptInput): Promise<void>
  command(input: { command: string; arguments?: string }): Promise<void>
  compact(): Promise<void>
  interrupt(): Promise<void>
  switchAgent(agent: string): Promise<void>
  switchModel(model: ModelRef): Promise<void>
  update(patch: { title?: string; permissions?: PermissionRuleset }): Promise<void>
  fork(before?: string): Promise<SessionHandle>
  replyPermission(requestID: string, reply: "once" | "always" | "reject"): Promise<void>
  replyForm(formID: string, reply: unknown): Promise<void>
  setEnvironment(env: Record<string, string>): Promise<void>
  context(): Promise<readonly OpenCodeMessage[]>
}
```

**Depth:** callers (the bridge) learn ~15 methods. Behind them: service discovery, auth headers, location query encoding, SSE lifetime, 409 SessionBusy, event filtering, Model.Ref encoding, permission/form translation, version predicates.

**Adapters:** `shared-service.ts` (discovery) and `explicit-url.ts` both produce an endpoint; one `http-runtime.ts` implements `OpenCodeRuntime` over `@opencode/client` for either. `fake-runtime.ts` is the in-memory test double. One factory. Tests talk to the fake `OpenCodeRuntime` — they do not mock `fetch`.

**Deletion test:** if this module vanished, every OpenCode HTTP detail would leak into `bridge.ts`. It earns its keep.

### 4.2 Plugin layout (proposed paths)

Mirror `plugins/provider-pi/` and `examples/plugins/echo-provider/`:

```
plugins/provider-opencode/
  package.json                 # name: bb-plugin-provider-opencode
  server.ts                    # bb.providers.register
  server.test.ts
  public-sdk-only.test.ts
  PLUGIN_OVERVIEW.md
  README.md
  app.tsx                      # optional: agent picker, integration connect
  icons/opencode.svg           # reuse plugins/provider-acp/icons/opencode.svg
  skills/opencode-provider/SKILL.md
  src/declaration.ts
  src/host.ts
  src/native-roots.ts
  src/session-params.ts
  src/permissions.ts           # bb mode → ruleset
  src/models.ts                # Model.Info → AvailableModel
  src/delta-translation.ts     # v2 events → thread/delta
  src/runtime/index.ts         # factory + OpenCodeRuntime interface
  src/runtime/discovery.ts     # D3 scan: glob service*.json, /api/info liveness, app selection
  src/runtime/shared-service.ts
  src/runtime/explicit-url.ts
  src/runtime/http-runtime.ts  # OpenCodeRuntime over @opencode/client for either endpoint
  src/runtime/fake-runtime.ts  # test double
  src/bridge/bridge.ts
  src/bridge/provider-maintenance.ts
```

Wire-up (same files Pi touched):

- `plugins/bb-official.json` — add `provider-opencode`
- `apps/server/src/services/plugins/builtin-registry.ts` — bundled, `defaultEnabled: true`, next to the other providers
- turbo pipeline — copy the `bb-plugin-provider-pi` task pattern
- `packages/templates/src/templates/bb-guide-providers.md`
- `plugins/bb-guide/skills/bb-cli/` — not touched; no core CLI flag in this plan (per-thread agent slot is a separate plan)
- `docs/configuration.md` — OpenCode native vs `acp-opencode`
- `docs/cli-guide-and-skill.md` list

### 4.3 Declaration (target)

```ts
{
  id: "opencode",
  displayName: "OpenCode",
  icon: "./icons/opencode.svg",
  experimental_visibility: "installed",
  models: { scope: "workspace" },
  maintenance: { health: true, usage: false, installation: true },
  env: { passthrough: ["BB_OPENCODE_SERVER", "BB_OPENCODE_PASSWORD", "BB_OPENCODE_APP"] },
  capabilities: {
    supportsServiceTier: false,          // unless model/list proves a fast variant
    supportsNativeUserQuestion: true,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsThreadArchive: false,
    supportsThreadRename: true,
    permissionModes: ["accept-edits", "auto", "full"],
    reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  composerActions: ["plan"],
  experimental_nativeSkillRoots: { /* D8 */ },
  experimental_nativeCommandRoots: { /* .opencode/commands */ },
  experimental_resolvesNativeRoots: true,
  deriveProviderOptions(ctx) { /* defaultAgent, promptMode→plan, runtime */ },
}
```

Handshake:

```
grammarVersions: [3, 3]
sessionRestore: true
fork: checkpoint
threadRename: true
threadArchive: false
approvalEnforcedBy: runtime
steerMode: inject
skills.configure: true
```

### 4.4 Event translation

`GET /api/event` is SSE; `@opencode/client` exposes `client.event.subscribe()` as `AsyncIterable` and exports the item type as `OpenCodeEvent` (`EventSubscribeOutput`). The OpenAPI schema types the raw payload as `V2EventEncoded` = `{ type: "string", contentMediaType: "application/json" }`, i.e. a JSON string the client decodes. The translator in `delta-translation.ts` is the dialect and takes decoded objects; it never sees SSE framing. Pin event names against a recorded fixture from a live v2 service in M0 — do not guess the envelope.

The stream is process-wide (one SSE connection per bridge, not per session). The runtime owns the single connection, demultiplexes by `sessionID` (and `parentID` for children), and reconnects with backoff; the bridge sees per-session `AsyncIterable`s. A reconnect after a gap triggers `session.context` to re-sync rather than assuming no events were missed.

Minimum mapping once fixtures exist:

| OpenCode | bb delta |
| --- | --- |
| assistant text / reasoning | `item.textDelta` / reasoning item |
| tool running/streaming/completed/error | `command` / `fileRead` / `search` / `tool` + `item.outputDelta` |
| permission request | `interaction/request` |
| form | `userQuestion` or `provider-opencode/form` extension kind |
| compaction running/completed/failed | compact turn / status |
| agent-switched / model-switched | synthetic system / extension.state |
| token usage | `usage`, `contextWindow` |
| child session | `delegation` + child turn |
| idle | turn settle |

Presentation on every `item.open`/`item.close`. Unknown tool names: generic `tool` with vendor title, never drop the item.

Subagent child sessions: subscribe (or filter the shared stream) for `parentID === session.id` and nest them. Do not flatten into the parent transcript.

### 4.5 Identity and lifecycle

```
bb thread id     thr_…
OpenCode session ses…     stored as providerThreadId
OpenCode message msg_…    stored as provider checkpoint ids on turns
```

`thread/identity` after create/fork. `session.replaced` if OpenCode ever mints a new id (import/export). Metadata `{ bbThreadId }` on create so a TUI user can see origin.

Idle reap: safe because `sessionRestorable` is true; the service keeps the session.

### 4.6 What stays ACP

`acp-opencode` remains for:

- OpenCode 1.x on PATH
- Hosts where discovery finds no v2 service and no v2-capable `shuvcode`/`opencode` binary, and the user has not set `BB_OPENCODE_SERVER`
- A plugin setting `compat: acp` after v2 ships, for people who want the old private-process isolation

Health on `opencode`: if the only binary is v1, status `unsupported_version` with install action; do not silently fall through to ACP under the `opencode` id.

## 5. In scope / out of scope

**In**

- Bundled `provider-opencode` plugin as above
- Shared-service client as default runtime
- Models, agents (default + plan + `defaultAgent` setting; per-thread picker is a separate plan), permissions, prompt, compact, interrupt, rename, checkpoint fork, resume, skills/commands, forms, context usage, installation/health
- Plan composer action → `plan` agent
- Keep `acp-opencode`
- Docs, CLI spawn as it exists today, plugin skill, guide templates
- Conformance kit + recorded live v2 fixtures

**Out (unless a later plan)**

- Driving OpenCode PTY / Mini / TUI / web
- Auto-installing a bb plugin into `opencode.json`
- Mutating user MCP/plugins on the shared service
- OpenCode worktrees as a replacement for bb environments (pass `location.directory` only)
- Session import from the TUI (nice follow-on: `experimental.session.import` / list + attach)
- In-place snapshot revert as bb rewind (follow-on for #3380)
- `supportsThreadArchive` until OpenCode publishes an archive route
- Encoding agents as model ids
- Changing ACP kit dialects
- Bumping `HOST_DAEMON_PROTOCOL_VERSION` at all. The per-thread `agent` slot is a separate cross-provider plan.
- Embedding `@opencode/sdk` / running an OpenCode server inside the bb host artifact
- bb `dynamicTools` on OpenCode threads (D7)
- Auto-starting `<app> serve --service` in M1 (gated on M0 item 3)

## 6. Dependencies

- `@opencode/client` pinned to one v2 release in the plugin `package.json` (2.0.10 today); import only `/promise` and `/service`. Host bundle includes it. `@opencode/sdk` is not a dependency.
- A live v2 HTTP service on the host (upstream `opencode`, Latitudes-Dev `shuvcode`, or another `Global.app` fork), or `BB_OPENCODE_SERVER`. Discovery, not a hardcoded binary name.
- Daemon egress must allow the registration URL (may be non-loopback).
- Existing bb surfaces only: `bb.providers.register`, `bb.settings.define`, provider-bridge v2 / grammar 3, `experimental_defineHostEntry`, `bridgeExecutionOptions.providerOptions`
- No new public plugin API and no daemon protocol change in any milestone of this plan.

## 7. Milestones

### M0 — Runtime spike (no product plugin)

Prove on a machine that already runs a v2 service (this host: shuvcode at `~/.local/state/shuvcode/service.json`, pid 3560093, URL `http://100.126.224.77:4096`; a stale upstream `service-<sha1>.json` sits next to it):

1. Run the D3 scan as a script. It must select the shuvcode registration, skip the stale upstream file (dead pid), and get 200 from `/api/info` with basic auth. Must **not** spawn anything.
2. `session.create` + `event.subscribe` + `session.prompt` through `@opencode/client/promise` against that endpoint.
3. In a throwaway `XDG_STATE_HOME`, run `shuvcode serve --service` and (if available) upstream `opencode serve --service`. Record which registration filename each writes (`service.json` vs `service-<sha1>.json`) and what the sha1 is keyed on. This decides whether D3 step 5 auto-start can ever be enabled and with which `file` argument.
4. Bundle a file importing only `@opencode/client/promise` + `@opencode/client/service` with the plugin build. Check the output for `effect` / `solid-js`. If present at runtime, D9's fetch-client fallback becomes the plan.
5. Capture a real event dump for one prompt that uses a tool, a permission ask, a form/question, a compaction, and a subagent. Record raw decoded events with session ids redacted.

Write findings into §0/§9. Do not guess event names past this point.

**Done when:** a checked-in fixture directory `plugins/provider-opencode/recordings/` (or `/tmp` notes if the plugin dir does not exist yet), item 3 answered, and item 4 answered.

### M1 — Plugin skeleton + health/models

Create `plugins/provider-opencode` from echo-provider + provider-pi shapes.

- `server.ts` registers `opencode`
- Bridge `initialize` + `provider/health` + `provider/installation/*` + `model/list`
- Runtime: `discovery.ts` (read-only scan) + `explicit-url.ts` + `http-runtime.ts`. **No auto-start** in M1; health reports `unknown` with a `statusMessage` telling the user to start `<app> serve --service` or open the TUI.
- `public-sdk-only.test.ts`, declaration tests, discovery tests against fixture state dirs (live shuvcode, stale upstream `service-<sha1>.json`, `.lock`/`.bak` noise, non-loopback URL), conformance bootstrap
- Bundled in `builtin-registry.ts` and `bb-official.json`

**Validate:**

```bash
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode
bb provider list --machine <host>
bb provider models opencode --machine <host>
```

Expect: provider appears when a v2 service is discovered (shuvcode counts); catalog matches that server's `GET /api/model` for the cwd. On this host that is `shuvcode api get /api/model`, not a newly spawned `opencode`.

### M2 — Sessions, prompt, deltas, permissions, compact, fork, resume

Implement `thread/start|resume|fork|stop`, `turn/start`, compact detection, permission/form interactions, plan→agent, defaultAgent setting.

**Validate (live host with v2):**

```bash
bb thread spawn --provider opencode --model <provider/id> --permission-mode accept-edits
# prompt, see tokens + tool rows
bb thread compact
bb thread fork
# kill the bridge (idle reap) and send another prompt — history intact
```

Plus recorded-conformance tests from M0 fixtures.

**Done when:** a thread survives bridge restart; compact is the compact RPC (assert via OpenCode session messages, not by grepping `"/compact"`); fork-at-checkpoint produces a new `ses` with truncated history.

### M3 — Skills, commands, native questions, usage deltas

- `GET /api/skill` / `command` in `resolveNativeRoots`
- Prompt skill attachments
- `session.command` for native slash commands
- Forms → userQuestion
- `TokenUsage.Info` → `usage` / `contextWindow`
- Plugin skill + guide + `docs/configuration.md`

**Validate:** `bb skill list` shows OpenCode nested skills; `/` picker runs an OpenCode command; AskUserQuestion plugin tool is absent on this provider.

### M4 — Per-thread agent slot (removed from this plan)

Moved to its own cross-provider plan: optional `agent` on thread start/turn, `bb thread spawn --agent`, SDK field, `docs/api_to_audit.md`, `HOST_DAEMON_PROTOCOL_VERSION` 216. This plan stops at settings + plan action (D5). The bridge already reads `providerOptions.agent`, so the later plan only has to fill that key from a new core slot; nothing here needs rework.

### M5 — Sunset policy for ACP

Document: `acp-opencode` is compatibility. Do not remove in the first release. A later issue can hide it when health says v2.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| `Service.ensure()` kills a server it considers stale/incompatible and `rm`s its registration | Never call `ensure` during discovery. Scan is read-only (`Service.discover` / direct `/api/info`). Auto-start only after M0 item 3, only with a file/command pair bb chose. |
| Two OpenCode servers, one sqlite db | Discover first; no auto-start in M1; no embedded server at all (§0). |
| Registration filename is not `service.json` (upstream writes `service-<sha1>.json` here) | Glob `service*.json`, ignore `.lock`/`.bak`; liveness by pid + `/api/info` pid match, not filename. |
| Stale registrations (dead pid, `0.0.0-next-*`) | `process.kill(pid, 0)` before HTTP; `/api/info.pid` must equal file pid. Never delete another app's file. |
| `opencode` on PATH is a fork symlink | App id from `--version` stdout, not `basename(argv0)`. |
| Registration URL is non-loopback | Use verbatim; daemon egress allowlist must include it; document for tailnet hosts. |
| `@opencode/client` pulls `effect` / `solid-js` peers into the host bundle | Import only `/promise` + `/service`; M0 item 4 checks the bundle; fallback is a typed fetch client (D9). |
| Event schema is `V2EventEncoded: string`; names drift | Recorded fixtures; translator tests; pin `@opencode/client` |
| HTTP API marked experimental | Pin client version; health rejects incompatible `server.info` |
| SSE connection drops mid-turn | Runtime reconnects with backoff; re-sync via `session.context`; bridge never assumes a gap-free stream (4.4). |
| Shared-service permission `always` writes project rules | Document; prefer `once` for runtime auto-approve |
| bb `dynamicTools` missing on OpenCode threads | D7. Declared gap, one warning per thread. Native questions still work via forms. |
| Session list pollution in the TUI | metadata + title prefix; do not list TUI sessions in bb |
| Location vs bb workspace mismatch | Always pass `location: { directory: cwd }` from `thread/start` |
| OpenCode session directory is authoritative on load | Never resume a session against a different cwd; `session.move` only if bb environment changes and we explicitly support it (out of M2) |
| Auth on explicit URL | `BB_OPENCODE_PASSWORD` + `Service.headers` with username `opencode`; do not invent tokens; never persist the password in bb rows |
| `HOST_DAEMON_PROTOCOL_VERSION` temptation | Do not bump in this plan. `providerOptions` already carries every knob M1–M3 need. |
| ACP and native both named OpenCode in the picker | Distinct ids and display: "OpenCode" vs "opencode" today. Rename ACP display to "OpenCode (ACP)" when native ships. |

## 9. Open decisions

Firm (decided by §0, no spike needed):

1. **Default adapter: shared service via read-only discovery.** The library's `ensure()` is destructive and single-file; this host already shows the stale-file + fork + tailnet combination it would mishandle. Explicit URL is the escape hatch. There is no embedded adapter.
2. **Per-thread `agent` slot is out of this plan.** `providerOptions` covers default + plan + setting with no daemon bump; the CLI flag needs a core slot and is cross-provider. Separate plan.
7. **No `@opencode/sdk`.** It is the server. Dependency is `@opencode/client` only. M0 bundle check of `@opencode/client/promise` and `@opencode/client/service` contains zero `effect` and zero `solid-js` (`recordings/bundle-check.json`), so the typed fetch-client fallback is not required.

Still open:

3. **Delete OpenCode session when bb deletes the thread?** Recommendation: no, setting default off. `session.remove` exists if the user opts in.
4. **Import an existing TUI session into bb.** Out of v1. `experimental.session.import` / `session.get` exist.
5. **In-place revert vs fork for rewind.** Recommendation: fork for bb rewind (matches Codex/Claude). `session.revert.stage/commit/clear` as a later composer action ("Undo files") for #3380.
6. **Usage windows for OpenCode Go.** Keep `maintenance.usage: false` until `experimental.session.stats` or integrations produce the same shape `provider-usage` expects.
8. **Auto-start when no service is live (D3 step 5).** M0 item 3 answered: both latest-channel binaries write unkeyed `service.json` under `$XDG_STATE_HOME/<app>/`. The filename is predictable, and auto-start stays **off**. Health, when nothing is live, tells the user to start the TUI or `<app> serve --service`. Recording the registration filename does not enable auto-start.
9. **Installer for the chosen app (`provider/installation/run`).** Upstream has a documented installer; shuvcode is `npm i -g shuvcode`. Recommendation: install only when no v2-capable binary and no registration exist, choose upstream by default, and honor `BB_OPENCODE_APP=shuvcode` for the npm path. Never "upgrade" a fork to upstream.

## 10. Rollback

- Plugin is disable-able (`bb plugin disable provider-opencode`). Threads on `opencode` cannot run until it is re-enabled; `acp-opencode` threads are untouched.
- Bundled defaultEnabled can flip to false in a patch if v2 client breaks.
- No daemon protocol change in M1–M3 → enrolled machines do not need a daemon bump to ignore the plugin.

## 11. Validation summary

Package:

```bash
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode
```

Must include: public-sdk-only, declaration, permission mapping unit tests, delta-translation against recorded events, provider-bridge conformance (echo-provider's kit).

Live (v2 service running; on this host `<app>` is `shuvcode`):

```bash
<app> --version                                    # prints "<app> v2.x…"
ls ~/.local/state/<app>/service*.json              # live registration exists
bb provider list                                   # opencode → ready, no new process spawned
bb provider models opencode
bb thread spawn --provider opencode --model <id>
bb thread compact
bb thread fork
```

Negative:

- v1-only host: `opencode` hidden or `unsupported_version`; `acp-opencode` still works
- Host with only a stale `service-<sha1>.json` (dead pid): `unknown` + `statusMessage`; nothing spawned
- Explicit `BB_OPENCODE_SERVER` with wrong `BB_OPENCODE_PASSWORD`: `unauthenticated`, not `unknown`
- Resume after killing the bridge process: same OpenCode `ses`, history present
- Compact must not appear as a user prompt `"/compact"` in `session.context`

## 12. Why not the alternatives

**ACP v2-flavored (`opencode acp` forever).** v2 ACP is still protocol 1, private server, no shared service, no Mode picker in bb, tip fork, text skills, `/compact` as a prompt. That is what we have. It cannot use the API "to its full capabilities."

**SDK embed (`@opencode/sdk`) as a runtime.** Rejected outright, not kept as an adapter. `@opencode/sdk@2.0.10` depends on `@opencode/server`, `@opencode/core`, `@opencode/plugin` and `effect`; it is the whole OpenCode server. Bundling it into the bb host artifact means shipping a second OpenCode that either shares the user's sqlite db with the running service or loses their integrations. Users who want isolation run `<app> serve --port … --password …` themselves and point `BB_OPENCODE_SERVER` at it.

**Upstream `Service.ensure()` as discovery.** It reads one file, kills what it does not recognize, and spawns the upstream binary. On this host it would skip the live shuvcode registration, find a stale keyed upstream file, and spawn `opencode` (a symlink to `shuvcode`) with no coordination. Read-only discovery (D3) replaces it.

**bb hosts OpenCode and the TUI attaches to bb.** Inverts OpenCode's model. Out of scope. bb is a client.

**Third-party `bb-opencode` marketplace plugin talking to `opencode serve`.** Useful experiment; first-party still needs the bundled plugin, conformance, guide, CLI parity, and the Runtime seam.

---

Saved as `PLAN-opencode-v2.md`. Not implementing.
