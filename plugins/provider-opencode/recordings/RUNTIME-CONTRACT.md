# M0 runtime contract (2026-09-20)

Spike only. No product plugin. Live pid `3560093` (`shuvcode serve --service`) was never restarted, killed, or re-registered. Isolated `serve --service` processes used `/tmp/shuvcode/m0-iso-*` XDG roots and were stopped by their own pids.

Sources: OpenCode v2 docs (`/v2/docs/build/client`, `/v2/docs/api`, `/v2/docs/troubleshooting`), `@opencode/client@2.0.10` / `2.0.11`, live shuvcode `2.0.8-shuv.1`, isolated `@opencode/cli-linux-x64@2.0.11`.

## 1. Discovery (D3) — proven

Scan `$XDG_STATE_HOME/*/service*.json`, ignore `*.lock` / `*.bak`. A registration is live only if JSON has `url` + `pid`, `process.kill(pid, 0)` succeeds, and `GET {url}/api/info` with basic auth returns 200 whose `body.pid === file.pid`.

This host:

| file | app | live? | why |
| --- | --- | --- | --- |
| `~/.local/state/shuvcode/service.json` | shuvcode | yes | pid 3560093 alive; `/api/info` 200 pid match; version `2.0.8-shuv.1`; url `http://100.126.224.77:4096` (tailnet, not loopback) |
| `~/.local/state/opencode/service-edee9402d198b04ac77dcf5dc9cc3dac44573782.json` | opencode | no | pid 3094697 dead; fetch failed. Filename is `service-${sha1("next")}.json` (legacy next-channel) |

Unauthenticated `GET /api/info` → **401** empty body. Authenticated → **200** `ServerInfo`. `GET /api/status` → **404**. Default `Service.discover()` (no `file`) looks only at `$XDG_STATE_HOME/opencode/service.json` and returned **undefined** here; it did **not** spawn or kill. `Service.discover({ file: shuvcodePath })` returned `{ url, auth: { type: "basic", username: "opencode", password } }`.

`opencode` on PATH is a symlink to `shuvcode`; `--version` prints `shuvcode v2.0.8-shuv.1`. App id is the state-root directory name / version string, not `argv0`.

**Never call `Service.ensure()` during scan.** Published `2.0.10` `dist/promise/service.js` default command is `["opencode","serve","--service"]`; default file is `opencode/service.json`; on timeout×3 or version mismatch it SIGTERM/SIGKILL + `rm`s the file. The published client’s `fallback()` cannot see shuvcode.

Auth: `Service.headers(endpoint)` → `Authorization: Basic base64("opencode:" + password)`. Username is always `opencode` even on shuvcode. Re-read the registration file; do not persist the password.

Use the registration `url` verbatim (may be non-loopback). This environment had `OPENCODE_CONFIG_DIR=/home/shuv/.config/shuvcode`; isolated tests must unset it.

Fixture: `d3-discovery.json`.

## 2. Isolated `serve --service` filename (M0 item 3) — answered

Both current latest-channel binaries write **unkeyed** `service.json` under `Global.app`:

| binary | version | isolated XDG file | url |
| --- | --- | --- | --- |
| `shuvcode serve --service --hostname 127.0.0.1 --port 14096` | 2.0.8-shuv.1 | `$XDG_STATE_HOME/shuvcode/service.json` | `http://127.0.0.1:14096` |
| `@opencode/cli-linux-x64` `opencode serve --service --hostname 127.0.0.1 --port 14097` | 2.0.11 | `$XDG_STATE_HOME/opencode/service.json` | `http://127.0.0.1:14097` |

Live shuvcode registration inode/mtime/pid were unchanged after both isolated runs.

No upstream `opencode` binary on PATH. npm package `opencode` 404s. Upstream v2 CLI is `@opencode/cli@2.0.11` (wrapper requires postinstall; platform binary `@opencode/cli-linux-x64` runs). V1 leftover: `opencode-ai@1.18.31`.

Keyed `service-<sha1>.json` is **legacy channel** naming: `Hash.fast(channel) === sha1(channel)`. `sha1("next") === edee9402d198b04ac77dcf5dc9cc3dac44573782`. Current code for `latest|dev|beta|next` writes `service.json`.

**Auto-start (D3 step 5):** the `file` argument for a latest-channel binary **is predictable**: `join(xdgState, appId, "service.json")` with `command: [binary, "serve", "--service"]`. Discovery must still glob `service*.json` because stale keyed files exist. M1 can keep auto-start off as planned; it is no longer blocked by an unpredictable filename.

Fixtures: `isolated-shuvcode-registration.json`, `isolated-upstream-registration.json`.

## 3. Bundle / peer deps (M0 item 4) — promise+service is clean

`@opencode/client` peerDeps: `effect@4.0.0-rc.112` (optional), `solid-js>=1.9.0` (optional). Runtime deps: `@opencode/schema`, `@opencode/protocol`. **Those two hard-depend on `effect`**, so `npm install @opencode/client` still installs `effect` in node_modules (`npm ls` confirmed).

esbuild of

```js
import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/service"
```

with `{ bundle: true, format: "esm", platform: "node" }` (same shape as plugin host/server):

| version | bytes | `effect` / `solid-js` / `@opencode/schema` in output |
| --- | --- | --- |
| 2.0.10 | 85830 | **0** |
| 2.0.11 | 85424 | **0** |

**Verdict:** D9 fetch-client fallback is **not** required for the bundled host artifact if the plugin imports only `/promise` and `/service`. Do not import `./effect`, `./effect/service`, or `./solid`. `@opencode/sdk` is still the server; do not depend on it.

Fixture: `bundle-check.json`.

## 4. Published client signatures (2.0.10, used live)

`EventSubscribeOutput` is `V2Event` (already decoded). OpenAPI `V2EventEncoded` is a JSON string; the promise client parses it.

| call | proven signature |
| --- | --- |
| `OpenCode.make` | `{ baseUrl, headers? }` |
| `client.server.info()` | `ServerInfo { version, pid, urls[], paths: { tmp } }` |
| `client.event.subscribe` | `({ signal?: AbortSignal, onActivity?: () => void }) => AsyncIterable<V2Event>` — **not** `(undefined, requestOptions)` |
| `client.session.create` | returns **`SessionInfo`**, not `{ data }` |
| `client.session.prompt` | `{ sessionID, text, delivery?: "steer"\|"queue", files?, agents?, skills?, id? }` → `SessionInboxUser` |
| `client.session.compact` | `{ sessionID }` → `SessionInboxCompaction { type: "compaction", delivery }` |
| `client.session.form.create` | `{ sessionID, title, fields[] }` → `FormInfo { id, sessionID, title, fields }` |
| `client.session.form.reply` | `{ sessionID, formID, answer }` — field is **`answer`**, not `answers` |
| `client.permission.reply` | `{ sessionID, requestID, decision: "once"\|"always"\|"reject" }` — **not** `client.session.permission.reply`; request field is **`decision`** |
| `client.permission.list` | `{ sessionID }` → pending `PermissionRequest[]` |
| `client.model.list` / `default` | `{ location?: { directory } }` → `{ location, data }` |
| `client.agent.list` | `{ location?: { directory } }` → `{ location, data }` |

`ModelRef` is `{ id, providerID, variant? }` (`id` is the model id, not a combined string).

SSE is process-wide, live-only, no replay, no auto-reconnect (v2 client docs). Filter by `data.sessionID` and child `data.parentID`. A late subscriber only gets the current `server.connected` marker.

Live `/openapi.json`: 113 paths, **136** operationIds (same count as published v2 OpenAPI). HTTP surface marked experimental.

Fixture: `client-signatures.json`.

## 5. Live events (sanitized) — captured, not invented

Created session title `bb: m0-spike do-not-use`, metadata `{ bbThreadId, bbPurpose }`, location `/tmp/shuvcode/m0-workspace`, permissions `[{action:"*",resource:"*",effect:"ask"},{action:"question",resource:"*",effect:"allow"}]`. Prompted through `@opencode/client/promise` against the **existing** shuvcode service. Live pid unchanged.

Observed on the spike session:

`server.connected`, `session.created`, `session.inbox.enqueued`, `session.execution.started`, `session.instructions.updated`, `session.inbox.delivered`, `session.step.started`, `session.tool.input.started|ended`, `session.tool.called`, `permission.asked`, `session.step.streamed`, `permission.replied`, `session.tool.success`, `session.step.ended`, `session.usage.updated`, `session.text.started|delta|ended`, `session.execution.succeeded`, `form.created`, `form.replied`, `session.compaction.started|delta|ended`

Child explore session additionally: `session.created` with **`data.parentID`**, `data.agent: "explore"`, inherited parent `metadata` and `permissions`, then the same tool/permission stream on the child id.

**Not observed** (do not guess): `session.idle`, `session.compaction.failed`, `form.cancelled`, `session.forked`, `session.permissions` (ruleset-changed event). Settle on `session.execution.succeeded|failed|interrupted` until idle is recorded.

Envelope facts:

- Many session events have `durable: { aggregateID, seq, version }`. `permission.asked`, `permission.replied`, `form.created`, `form.replied`, `session.usage.updated`, `session.text.delta` did **not**.
- `permission.asked.data`: `{ id, sessionID, action, resources[], save?, source?: { type:"tool", messageID, id }, metadata? }`. Subagent ask: `action: "subagent", resources: ["explore"]`. Read ask: `action: "read", resources: ["hello.txt"]`.
- `permission.replied.data`: `{ sessionID, requestID, reply: "once"|"always"|"reject" }` — event field is **`reply`**, API input is **`decision`**.
- `form.created.data.form` is `FormInfo`. `form.replied.data`: `{ id, sessionID, answer }`.
- `session.tool.called.data`: `{ sessionID, assistantMessageID, id, input, executed, state? }`. `state.thoughtSignature` is sensitive; strip it.
- `session.compaction.started.data`: `{ sessionID, reason: "manual", recent, inputID }`. Compact RPC returns immediately; completion is `session.compaction.ended`.
- `session.step.started.data` includes `{ agent, model: ModelRef, assistantMessageID }`.
- `server.connected`: `{ type, data: {} }` (may omit `created`).

`model.list` at the throwaway `/tmp` workspace returned **0** models and `default.data: null`, but the session still ran (`google` / `gemini-3.7-flash-high`). Same calls at `/home/shuv/repos/bb-opencode-v2`: **582** models, default `{ providerID: "google", id: "gemini-3.7-flash-high" }`. Catalog is location-scoped; pass thread cwd.

Agents at the workspace: `build`/`plan` primary visible; `general`/`explore` subagent; hidden `compaction`/`title`/`summary`.

TokenUsage on `Session.Info.tokens`: `{ input, output, reasoning, cache: { read, write } }` plus `cost`. Do not treat the field name `tokens` as a secret.

Fixtures: `events-owned.sanitized.json`, `event-samples.json`, `child-events.sanitized.json`, `event-types.json`.

## 6. Blockers / follow-on rules

1. Discovery **must** glob + pass `file` into `Service.discover`. Default discover misses shuvcode.
2. **Never** `Service.ensure` unless bb chose `{ file, command }` and no live compatible service exists. M1: no auto-start.
3. Import only `@opencode/client/promise` + `@opencode/client/service`. Bundle check passed; still do not import effect/solid entrypoints.
4. Permission reply is `client.permission.reply({ decision })`. Form reply is `{ answer }`. Event names/fields are in the fixtures — pin the translator to those, not OpenAPI string encoding.
5. Filter SSE by session id **and** child `parentID`. Child sessions inherit bb metadata.
6. Daemon egress must allow the registration URL as written (tailnet here).
7. `session.idle` is not a proven settle signal on this capture.
8. No product implementation in this spike. Spike session left on the shared service with title `bb: m0-spike do-not-use` (not removed).

## 7. Mapping blockers (BB contract review) — proven 2026-09-20

Live probes used a **new** session `bb: m0-mapping-spike do-not-use` at `/tmp/shuvcode/m0-workspace`. Unrelated sessions were not prompted or permission-replied. Live pid unchanged. Evidence: `mapping-blockers.sanitized.json`, `client-signatures.json`.

### 7.1 `options.instructions` + `instructionMode`

Exact generated surface (`@opencode/client@2.0.10`):

- `SessionCreateInput` / `SessionUpdateInput` have **no** `instructions` field. Update is `{ title?, permissions? }` only.
- Session-specific API: `client.session.instructions.entry.{list,put,remove}`
  - put `{ sessionID, key, value: JsonValue }` → 204
  - `InstructionEntry.Key` OpenAPI pattern `^[a-z0-9][a-z0-9._-]*$` (no `/`)
  - list returns `{ key, value }` **plaintext** (unlike events)

Live:

| attempt | result |
| --- | --- |
| put `bb.instructions` = append marker | 204; list shows plaintext |
| put `bb/user` | **400** InvalidRequestError (slash not in key pattern) |
| put `core.instructions` = replace attempt | 204 as a **new API entry**; did **not** replace ambient AGENTS.md |
| remove `bb.instructions` | 204; list keeps `core.instructions` API entry |

First model step after put emitted `session.instructions.updated` with `data.delta` hashes only (`text` absent):

- ambient: `core/environment`, `core/date`, `core/codemode`, `core/instructions`, `core/skill-guidance`, `core/mcp-guidance`
- API: `api/bb.instructions`, `api/core.instructions`

v2 docs: session API entries are source **6**, **combined** with AGENTS.md, not overrides. Config `instructions` array is **not resolved in V2**.

**Append (proven):** put `bb.instructions` (or another legal key) with the bb instruction string. Do not mutate `opencode.json` / `AGENTS.md`.

**Replace (impossible via session API):** there is no call that clears `core/instructions` or agent/provider system prompts. Putting `core.instructions` adds `api/core.instructions` beside ambient `core/instructions`. Replace would require writing/deleting AGENTS.md or agent config — global/project mutation, forbidden.

### 7.2 Skills: `skills/configure` vs prompt mentions vs `PromptInput.skills[]`

bb handshake `skills/configure` sends `{ roots: [{ id, path, skills: [{ name, description }] }] }` with **filesystem** `<path>/<name>/SKILL.md`. bb turn mentions activate skills; bb does **not** send a `PromptInput.skills[]` of its own.

OpenCode generated prompt input is `skills?: ReadonlyArray<{ id: string, mention? }>`. Stored/expanded `PromptSkillAttachment` is `{ id, name, text?, mention? }`. `experimental.session.skill` is `{ sessionID, id, resume? }` — OpenAPI: “Activate a skill … by appending a skill message and resuming execution.”

Live:

| id | `session.skill` | `session.prompt({ skills:[{id}] })` |
| --- | --- | --- |
| catalog `m0-probe` | 204 + `session.skill.activated` `{ id, name, text }` + context `type:"skill"` | 200; `payload.skills` expanded to `{ id, name, text }` (full body) |
| `injected-skill` (not in catalog) | 404 `SkillNotFoundError` | 400 `InvalidRequestError` Skill not found |
| absolute dir / `SKILL.md` path | same 404 | same 400 |

There is **no** session API to register a skill root. `skills/configure` paths that are not already inside OpenCode discovery (`.opencode/skills`, `.agents/skills`, `.claude/skills`, `~/.config/<app>/skills`, config `skills` array) **cannot** be activated. Doing so would require writing `opencode.json` `skills[]` or dropping files into a discovered root.

**Proven mapping:** mention → OpenCode `{ id }` of a **catalog** skill from `GET /api/skill`. Do not send bb `PromptInput.skills[]`. Do not pass filesystem paths as `id`.

**Impossible:** activate a bb-only injected skill that OpenCode has not already loaded.

### 7.3 Native roots = filesystem paths only

`SkillInfo` (generated + live keys): `{ id, name, description?, autoinvoke?, path: string, content: string }`. Extra keys: none. `httpPathCount` on this host: **0**.

- Real host paths: `<HOME>/.agents/skills/<id>/SKILL.md`, workspace `.opencode/skills/m0-probe/SKILL.md`
- **Not** a host path: `/builtin/opencode.md` (virtual builtin). A filesystem resolver cannot scan it.
- HTTP catalogs: documented by v2; **not observed**. Do not assume `path` is a URL; do not assume it is a cache file. Unproven.

`CommandInfo` live+generated: `{ name, description? }` **only**. **No `path`.** `GET /api/command` cannot feed a filesystem native-command resolver. Commands are name-only; `session.command({ name, text })`. Unknown name → `CommandNotFoundError`. Filesystem fallback remains `.opencode/commands` as documented, not the HTTP list.

### 7.4 Fork `before` vs bb checkpoint

Generated: `SessionForkInput = { sessionID, before?: string /* ^msg_ */ }`. OpenAPI: “copying projected history **before** a message. Omit before to copy the full history.” `additionalProperties: false`. `SessionForkBoundary` type still includes `through`, but that is on `Session.Info.fork` / `session.forked`, not on the generated fork **input**.

Live (`before` exclusive — proven):

- `fork({ before: SYN_B })` → `boundary.type: "before"`; context has SYN_A, **not** SYN_B
- `fork({ before: SYN_A })` → does **not** include SYN_A
- empty session / undelivered inbox id → `empty_session` / `MessageNotFoundError`
- `{ before: { type, messageID } }` → 400 “Expected string | null at [before]”

bb checkpoint = **include** the completed turn. OpenCode `before` = **exclude** the named message.

**Proven mapping:** if checkpoint message is M and N is the next context message, `fork({ before: N.id })` includes M. If M is last, omit `before` (full copy). Passing `before: M.id` drops M and is wrong for checkpoint.

Raw HTTP `{ through: msg_ }` returned 200 with `boundary.type: "through"` even though OpenAPI/generated client omit it. In this capture the through-fork context **still contained messages after SYN_B**, so inclusive truncation is **not proven**. Do not use `through` until a capture shows it.

### 7.5 Model variants / bb efforts

`ModelInfo.variants: Array<{ id, settings?, headers?, body? }>`. Observed variant ids on this catalog: `none`, `low`, `medium`, `high`, `xhigh`, `max`, `minimal`, `thinking`.

bb ladder `none|low|medium|high|xhigh|max`: **all exist** as some model’s variant id. OpenCode-only: `minimal`, `thinking` (keep as labelled extra efforts, do not invent bb enum members).

Default on this host: `google` / `gemini-3.7-flash-high` with **`variants: []`**. Neighboring google rows are separate model ids (`…-high` / `…-medium` / `…-low`), not variants. Switching google effort is a **different `ModelRef.id`**, not `variant`.

`ModelRef` remains `{ id, providerID, variant? }`. `model.default` returns `{ location, data: ModelInfo | null }`.

### 7.6 Environment / context (signatures, live)

- `client.session.environment({ sessionID, variables: Record<string,string> })` → 204. Session-scoped; not global config.
- `client.session.context({ sessionID })` → `SessionMessageInfo[]` (live types seen: `skill`, `synthetic`, `user`, `assistant`, `system`, `idle`).

### 7.7 Impossible vs mapped (summary)

| bb need | OpenCode | status |
| --- | --- | --- |
| instructionMode append | `instructions.entry.put({ key: "bb.instructions", value })` | proven |
| instructionMode replace | no session API; ambient `core/*` remain | **impossible** without config/file mutation |
| instructions on create/update | fields do not exist | **impossible** |
| skills/configure extra roots | no session skill-root API | **impossible** without config/fs mutation |
| mention → activate catalog skill | `prompt.skills: [{ id }]` or `session.skill({ id })` | proven |
| prompt.skills path / unknown id | SkillNotFound / InvalidRequestError | **impossible** |
| native skill roots from API | `SkillInfo.path` (filesystem or `/builtin/…`) | filesystem paths usable; builtins not host paths; HTTP unproven |
| native command roots from API | `CommandInfo` has no path | **impossible**; names only |
| fork checkpoint include turn | `before` is exclusive | map to **next** msg or omit |
| fork `through` | not in generated client; live 200 unproven | **do not use** |
| reasoning ladder | `variants[].id` or google id suffix | mixed; see 7.5 |
