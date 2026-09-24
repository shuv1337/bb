# First-class bb tools for OpenCode v2

Investigation: 2026-09-23 PDT. Revised 2026-09-24 PDT after source-verified multi-lens review (see `REVIEW-opencode-v2-bb-tools.md`). Status: recommended design; not implemented or deployed.

## Recommendation

Add a small OpenCode-native companion plugin, published and released as a **standalone repository and package** like any other OpenCode v2 plugin, installed with the engine's own `plugin add` command. Connect the bb provider to it through OpenCode's existing authenticated plugin RPC. The companion registers actual native tools and waits for bb to execute them through the existing `item/tool/call` contract.

This is a credible path to full **bb tool parity** without restoring the historical session-tools engine API. Public extension primitives cover the main callback path. For full result fidelity, also implement a bounded native **rich-error result feature**: typed failures currently discard content, and AI protocol encoders stringify error objects instead of preserving their images. A companion metadata workaround would bypass normal output handling and depend on hooks for every replay. Prefer an explicit engine contract. The complete integration has not yet been prototyped; milestone 0 proves the composition before larger implementation.

Recommended delivery has three parts: **the standalone companion package**, **provider integration in `plugins/provider-opencode`** (no bb core changes), and **rich-error support in Shuvcode's existing tool/result pipeline**. Rich errors raise fidelity; they are not a prerequisite for parity of ordinary calls. Stock OpenCode can support ordinary calls, successful media and text failures through the companion; it cannot be called fully faithful for rich failures until it includes the corresponding capability. On engines without it, a failed result degrades to its ordered text blocks plus an explicit `[N image(s) omitted: engine lacks rich tool errors]` marker, advertised through `hello`; never silently dropped. Keep that distinction visible in compatibility status and documentation. The rich-error work lives only in our Shuvcode fork and is carried as a fork patch across upstream syncs. Nothing in this plan is upstreamed.

The material cost is a one-time companion installation on each native service host, done through the engine's standard plugin workflow (`opencode plugin add <package>`, or the Shuvcode CLI equivalent, which installs the package and adds it to the engine's global config; `plugin check|update|remove` manage its lifecycle). Installing a bb plugin cannot add an OpenCode plugin through HTTP, and bb does not install, upgrade or remove the companion itself. The bb plugin stays installable from **main + `plugins/provider-opencode`**; it explains the companion, links to it, and reports its status, but never ships or writes companion files.

No bb core changes: no server, host-daemon, agent-runtime, provider-bridge-protocol or Plugin SDK changes and no `HOST_DAEMON_PROTOCOL_VERSION` bump. All bb work stays in `plugins/provider-opencode`. If implementation hits a genuine core blocker, stop and record it rather than working around it in core.

“Full bb tool parity” means selected built-in/plugin tools, their schemas, results, user input, cancellation, thread ownership, and UI presentation work through bb. It does not imply all unrelated native features become configurable through bb, exactly-once external side effects, or a change to OpenCode's global restart policy.

## Verified baseline

| Surface | Investigated revision/state |
| --- | --- |
| bb | `190a1b2c6` on clean `main`, tracking `origin/main` before this report |
| Shuvcode | `be4c643d671bfee38121a4e827934c5c2efd3dff` = tag `v2.0.15-shuv.1`. As of 2026-09-24 `origin/integration-v2` is `5e751cd0a` (CLI branding only; no cited path changed) |
| Included upstream base | `757e565c23` |
| Latest upstream v2 checked | `ff6b8c21e7925dfcc86ede7101f98e8e291667ff`, verified by remote ref query; relevant tool/plugin RPC extension surfaces remain present |
| Provider client | Pinned `@opencode/client@2.0.10`; npm latest for `@opencode/client` and `@opencode/plugin` is `2.0.16` as of 2026-09-24 (unverified; add to the milestone-0 matrix or mark unsupported) |
| Public bb installation contract | bb >=0.43.4, Plugin SDK >=0.5.9 <0.6.0; preserve standalone subdirectory installation |

Source inspection, existing isolated tests, and registry/ref queries were performed. No production service configuration, installed plugin, binary, or live thread was changed. No paid model calls were made. Installed host versions were not refreshed in this investigation; deployment acceptance must inventory each host again.

### Why the warning appears

`constructSession` receives `dynamicTools` on start/resume/fork but narrows them to names and calls `warnDroppedTools`. Nothing registers their schemas with the engine, forwards a native invocation to bb, or returns a result to the model. This is an intentionally missing execution path, not a disabled setting. [B1]

The example `update_environment_directory` is always injected by bb. It changes bb's owning thread environment for subsequent turns; shell `cd` does not replace it. Its result instructs the agent to stop the current turn because the running provider cwd has not changed. [B2]

Existing “turn-tools” recordings exercise native tools only. They can pass while bb tools are completely unavailable. [B3]

### What already exists

bb selects tools on the server, sends definitions during session construction, accepts reverse `item/tool/call` RPC, validates daemon host/thread ownership, executes the built-in or plugin callback, and returns ordered text/image content. No new bb execution endpoint is necessary. Codex, Claude, and Pi already use this contract. [B4–B7]

Current OpenCode public plugin APIs provide tool registration/reload, session-specific catalog filtering/aliasing, complete native execution identity, typed results/errors, cancellation, and authenticated custom RPC. [N1–N5]

Historical Shuvcode had session dynamic-tool APIs. The fresh-v2 rewrite explicitly excluded them; neither current Shuvcode nor inspected upstream v2 contains them. Do not call the historical endpoints or resurrect the old implementation wholesale. [N6]

## Options considered

| Approach | Benefit | Limitation | Decision |
| --- | --- | --- | --- |
| Native companion + plugin RPC | Full direct-call identity, session catalog control, typed text failures, successful media, native cancellation; public extension APIs | Requires host installation and its own session/call lifecycle; full rich failures need the separate engine feature below | Recommended foundation |
| Runtime MCP server | Existing runtime add/remove, schemas, results, cancellation | Location-wide catalog; only session ID in invocation metadata, no native call/message ID; expiry may retry transport; native permissions and names need adaptation; MCP `isError` keeps only text | Useful for basic dispatch, insufficient alone for the target. Not adopted as a degraded fallback when the companion is absent: it would need its own install/registration path and a second execution contract; the absent-companion policy below keeps native-only behavior instead |
| Add engine session-tools HTTP API | Can make session ownership/recovery a core contract | Engine/schema/protocol/client changes; fork maintenance; never available on stock engines | Reserve for a demonstrated blocker |
| Execute from `session.tool.called` SSE | Appears small | Observation does not supply an executable callback; stream can drop/replay, and existing UI data is sanitized | Reject |
| Shell commands or prompt instructions invoking bb | Minimal integration work | Misses schemas, typed results, identity, cancellation and normal plugin presentation | Reject |

MCP facts are specific to the investigated implementation: tool calls include `_meta['ai.opencode/sessionID']`; catalogs are Location-scoped, and message/call IDs are not forwarded. A plugin wrapped around MCP could fill the gaps, but then direct companion RPC has fewer moving parts. [N7]

## Architecture and ownership

```text
OpenCode model -> native companion tool executor
                -> authenticated pending/claim RPC -> bb provider bridge
                -> item/tool/call -> bb daemon -> bb server tool
                <- typed result  <- same reverse RPC
                <- companion result RPC <- bridge
OpenCode model continues with the actual result

Native tool events -> existing SSE -> bb transcript row
```

The bb server remains responsible for tool selection, instructions, project/thread context, execution, and user interaction. The daemon/provider translates native primitives. The companion knows only scoped bindings and tool callbacks; it receives no bb server credential or general bb API access.

Use the already authenticated OpenCode client channel, including its explicit remote-service mode. Do not add a callback HTTP listener, write credentials into engine configuration, call `Service.ensure`, or restart the shared service during discovery.

### Session binding and catalog

1. Preflight a versioned companion `hello` RPC at the intended Location before creating a session. Advertise actual features and limits, the companion's own install path and digest, the supported protocol range, and a **live rich-failure probe** result rather than a version-derived flag; app version or health-ready alone does not establish tool support. Fail attachment if more than one `bb.tools.v1` provider is registered (RPC routing is last-registration-wins).
2. Keep complete bb descriptors: name, description, input schema, and presentation. Tools are construction snapshots on start/resume/fork, not a new per-turn hot-reload feature. Retain descriptors in the bridge so a binding can be reattached without session reconstruction. [B5]
3. Bind the native root session to the bb thread, bridge instance/owner epoch, engine/plugin generation, and catalog digest. Return a random per-binding capability held in memory; every method except `hello` requires it. Reuse the **existing** `metadata.bbThreadId` marker and persisted owners map (`bridge.ts:539–542,1067–1125,1319,1711`); do not add a second marker. The marker never grants execution authority by itself. On bb `thread/fork`, merge-update the fork's metadata to the new bb `threadId` (native metadata update replaces the object, so read-merge-write); today the fork carries its source thread's ID. [N8]
4. Register unique short internal tool names per binding/catalog, then await `tool.reload()` before declaring the attachment ready or submitting a prompt. Validate the full catalog before changing live registration; failed installation must not leave a partial advertised set. Invalid registrations are only logged and an unconvertible schema silently disables native validation, so after `reload()` diff `tool.list()` against the expected set and roll back on mismatch. The companion compiles and validates bb input schemas itself.
5. In `session.context`, remove companion internals and move only the authorized **existing definition objects** to their canonical bb names. The runner matches definitions by identity and then by key, so an invented object stored under a registered name is kept; do not rely on it being dropped, and never construct new definitions. Hook alias keys bypass the native `^[A-Za-z0-9_-]{1,64}$` name check while bb names have no length cap: validate canonical names at attach time and reject collisions with native tools and `execute` explicitly rather than shadowing. Hook transforms must never throw: a throwing transform disables the whole plugin group. In the separate `session.compaction` and `session.generate` hooks, remove all companion tools: auxiliary requests do not execute bb tools in this design. Test every tool-bearing hook for foreign/internal catalog leakage. [N2, N12]
6. Set `codemode:false` and `options.permission` to the canonical bb name. Permission filtering runs on the internal tool before aliasing, so it must not use the private name. In investigated Shuvcode, direct tools remain in Code Mode's runtime inventory even when absent from discovery; ownership alone is insufficient. Latest inspected upstream `ff6b8c21` excludes them, but the bridge must support the actual shipped host behavior. Code Mode inner calls reuse the outer call identity. Enforce a **direct-origin check** (proven in milestone 0a): the first `execute.before` event for the call ID must name this binding's canonical bb tool, and it must be the only `execute.before` event for that call ID. Reject `execute`, private names, missing/mismatched calls and indirect invocation before creating pending work. Every executor also verifies current session ancestry, binding, catalog membership, owner generation, and liveness. [N3, N13]
7. Retained snapshots must not preserve revoked authority: recheck the live binding in the captured executor. Serialize registry changes and test simultaneous attachments to the same Location.
8. **Attach takeover.** A second `attach` for an already-bound root succeeds only with the current capability or after the current owner's heartbeat has expired. The realistic case is a restarted bridge reattaching while the old heartbeat is still live; it must wait for expiry or present the persisted-owner proof it already holds. On takeover, settle old-epoch calls (unclaimed → `owner replaced` failure, claimed → uncertain outcome), never transfer them, and surface a provider warning.
9. **Generation changes.** Location eviction (engine inactivity TTL, 60 minutes by default), Location reload, plugin reload and service replacement all change the generation and drop companion bindings. Before every `turn/start` and `turn/steer`, the bridge calls `hello` and a binding check (generation, epoch, catalog digest) in addition to today's `health()` refresh, and reattaches from retained descriptors on mismatch. If the generation changes during a turn, the companion's `session.context` hook fails the step with an explicit `bb tools reattaching` error instead of exposing an empty catalog; the bridge reattaches all live bindings immediately and the turn continues from the next step. [N16]

Do not silently drop unsupported schemas or tool names. Preserve JSON Schema structure, including supported `$defs`/nonrecursive references; return a precise attachment error if the native provider cannot represent a valid bb definition. bb's plain JSON-schema registration is not guaranteed to validate inputs at server execution; the native boundary must validate its advertised contract. [B8]

### Native children and bb forks

Native descendants inherit the owning bb root's selected catalog, subject to the native agent's restrictions. The root catalog must already be registered before the parent prompt.

Ancestry alone is not authority: the public `session.import` endpoint accepts a caller-supplied `parentID` and persists a real child (`transfer.ts:73,94`). A descendant is authorized only if the companion observed its creation by a direct-origin-verified `subagent` call from an already-authorized session (the subagent tool reports the child `sessionID` in progress, `subagent.ts:201`), recorded in the binding. Record this synchronously in the companion, without waiting for child-created SSE: native children can begin work before bb observes that event. Executor authorization repeats the check.

Children copy the root's permission rules once at creation and do not see later root updates. The companion executor enforces the root binding's **current** `disallowedTools` for every descendant call.

Forward the owning root `providerThreadId` and bb `threadId`, keeping actual native child session/message/call identity for correlation and nested UI. bb's identity registry does not register arbitrary native children as separate bb threads. Capture the owning active turn when dispatching; never redirect an old child call to a new turn. [B6, B9]

**Background subagents** (`subagent` with `background: true`) return immediately and can outlive the owning bb turn. The runtime rejects `turnId: null` and accepts a stale captured turn unchecked. Policy: when the captured owning turn has closed, the companion rejects the call before dispatch with a typed failure (`bb turn ended; bb tools are unavailable to background subagents after their owning turn`). Keeping bb turns open for background work is a product-policy change and out of scope.

A native fork has `parent_id = null` and copied metadata; it is not an authorized descendant. bb forks/side chats require a fresh binding and destination catalog. Unrelated, imported, or externally forked sessions cannot gain authority from metadata, a supplied `parentID`, or sharing a directory. The trust boundary remains authenticated engine access: any client holding engine credentials can already run arbitrary native tools. [N8]

There is no existing bb “root-only tool” flag. Do not invent a provider-private policy table. Under current bb semantics, a child's `update_environment_directory` call changes the **owning bb thread's** environment; the current owner turn should end according to the tool result. Test that behavior explicitly. A different product policy belongs on the bb server and would require an intentional shared-contract change.

### Environment directory migration

After `update_environment_directory`, the daemon resumes the thread with the new cwd, but `assertOwned` (`bridge.ts:1067–1103`, called at `:1362` outside `openSession`'s try/catch) throws because the native session is bound to the old Location, and the error is never mapped to `SESSION_NOT_RESTORABLE`. This becomes reachable as soon as bb tools work. Milestone 0a settled the mechanism: native fork cannot target another Location (its payload is only `{ before? }`), but `POST /api/session/:id/move` moves the session itself, preserving history, and the next turn runs at the new Location. Plugin state and RPC registrations are per Location, so the move drops the companion binding. On resume with a cwd that differs from the owner record **and** a bb thread ID that matches it, the bridge moves the native session, rebuilds its handle with the new Location, reattaches bb tools at the new Location, and persists the new owner. Unrelated sessions still fail ownership.

### Execution protocol

Proposed companion-private RPC namespace: `bb.tools.v1`. These are new methods to implement, not existing native endpoints:

| Method | Purpose |
| --- | --- |
| `hello` | Protocol/features/engine-plugin generation and negotiated size/concurrency limits |
| `attach` | Validate root and catalog, establish owner epoch/capability, await registry readiness |
| `pending` | Authoritative bounded snapshot or short long-poll; renew owner liveness independently of execution duration |
| `claim` | Atomically reserve one invocation for this owner before bb dispatch |
| `result` | Submit one typed terminal result, idempotently for that claim and identical payload |
| `detach` | Revoke binding, settle/cancel waiters, remove future catalog exposure |

Use the composite `(engine/plugin generation, binding epoch, native sessionID, assistantMessageID, callID)` as the call identity. Neither raw callID, tool name, nor matching arguments is sufficient. Validate JSON once at each transport boundary and keep typed values internally.

The native executor creates the pending entry **before** any optional wakeup event, then awaits its result. Companion RPC events are ephemeral, so polling remains authoritative. Keep the bb dispatch pump separate from the bridge's serial SSE queue and interaction-response map. A waiting tool must not block stop, permission replies, questions, or event reconciliation. [B10, N5]

`pending -> claimed -> result supplied -> settled` is the normal progression. Cancellation is terminal. Duplicate reads are harmless; duplicate claims cannot dispatch twice. Retry delivery of a known result without rerunning bb. An unacknowledged claim or previously claimed call after bridge loss is an uncertain outcome and must not be automatically dispatched by a replacement bridge. A claim may conservatively fail even when bb never received it; safety here trades availability for avoiding repeated external side effects. Settled records are retained only until a subsequent `pending` response acknowledges them or the epoch ends, and count against the negotiated budgets.

**bb never replies to a reverse call it cancels.** The agent runtime returns early without a result or error once a reverse `item/tool/call` is aborted (`runtime-provider-requests.ts:216–233`), and aborts happen on stop, detach, `notifications/cancelled`, and every `turn/completed` the bridge emits (`runtime.ts:334–335,1258–1283,2216`). The bridge therefore never awaits a reply after it emits a turn boundary, sends `notifications/cancelled`, or handles interrupt/stop/detach: it settles that turn's companion calls locally — cancelled if never dispatched, uncertain outcome if claimed — at the moment it causes the abort. Resync (`reconcileAfterResync`, `delta-translation.ts:676–721`) must not emit a turn boundary while that turn has pending or claimed companion calls.

Bridge reverse requests use a dedicated noncolliding JSON-RPC request ID, the original canonical bb tool name, and the captured root/turn/call mapping. Reuse current SDK response decoders where appropriate; its simple pending tracker generates synthetic IDs/null turn and is insufficient unchanged for this richer identity. When using native IDs, establish the delta mapping before forwarding `providerNativeIds:true`; otherwise pass the explicitly resolved bb turn/call identity. Do not rely on the adapter's fallback from an unknown native turn ID. [B6]

### Results, permissions, UI and user input

- Preserve ordered bb `inputText` and `inputImage` results. Map native media to `Tool.Result.content` file entries with URI/MIME; do not return `output` without an output schema. No extra audio/resource support is required for bb's current contract. Keep remote image URLs compatible with the existing bb behavior; never fetch arbitrary URLs during conversion.
- Prefer an Effect-native companion using typed `Tool.Error` and Effect interruption. The Promise tool adapter wraps execution with `Effect.promise`; a rejected promise can be a defect rather than the intended model-visible tool failure. A returned `success:false`, transport failure, and cancellation are distinct outcomes. Native `Tool.Error` currently has no result-content field: merely joining text into its message loses ordered blocks and failure images. On engines without rich errors, use the explicit degraded form from the Recommendation and advertise it in `hello`. On engines with rich errors, **success:false with multiple text blocks and an image** must keep native failed status, model context, UI, and reload/history fidelity. Never treat a successful error-shaped return as a real failure. [N1, N14, B8]
- **Engine plugin runtime surface.** Released engine builds expose a narrower virtual-module surface than the source packages: the SEA build's `@opencode/plugin` / `@opencode/plugin/effect` modules export no Rpc, Tool, Location or Mcp namespaces, `effect/tool` exports only `Error`, and `effect` itself is not provided; the Bun-compiled build provides no virtual modules. `core/tool/runtime.ts:36–43` rewraps any failure that is not `instanceof` the engine's `Tool.Error` as message-only, so a bundled `@opencode/schema` copy silently loses metadata and future rich content. Import `Tool.Error` only from the runtime-provided `@opencode/plugin/effect/tool`, use only names present in the runtime modules, pass a plain portable definition for RPC, bundle and document the companion's own `effect` copy, and test typed-failure metadata against both SEA and Bun artifacts. [N17]
- Do not impose a short ordinary-tool deadline. bb explicitly tests tools lasting over ten minutes. A live-owner heartbeat can bound abandoned waits independently of tool duration. Define finite outstanding-call/result-byte budgets and negotiate them; do not silently truncate results. The existing bb line ceiling is 64 MiB, not a promise that every native transport accepts that much. [B8]
- **Engine ceilings on tool duration and size.** The engine evicts a Location after 60 minutes without durable session events and interrupts active executions there; tool progress and plugin RPC do not count as activity. Any bb call longer than that is interrupted and its late result is undeliverable. Milestone 1b removes this ceiling: a Location with any tool call in flight is not idle. Until 1b is deployed on a host, the ceiling applies there and is documented. Undeliverable late results are reported to bb and give the model an explicit uncertain-outcome failure. Separately, every successful local tool result passes through native `toolOutput.truncate` (2,000 lines / 50 KiB, spilling the full text to a file on the engine host), unless `metadata.truncated` is already set. The companion sets `metadata.truncated: false` and relies on bb's own negotiated budgets, so bb output is never spilled to the engine host disk or replaced with an engine-local path. [N16, N18]
- bb plugin tools own their action approvals. Do not add an unconditional duplicate native permission prompt. Preserve native permissions and bb `disallowedTools` against canonical and internal aliases; catalog filtering alone cannot enforce them. Native sandbox permission modes do not sandbox server-side bb plugins. Provider permission modes are accept-edits/auto/full; plan is the native `plan` agent, which denies only `edit`, and `ask` rules never gate plugin tools. Expected outcomes: bb tools remain available in plan mode; only canonical wholly-deny rules remove them. Test those outcomes.
- Use native tool lifecycle events as the single row source. Normalize aliases to `server: "bb"`, canonical tool name and supplied presentation (labels/icon/tint/suppress); retain child `parentRef`. Do not create a second synthetic row when reverse RPC starts.
- Add real current `session.tool.failed` translation. During resync, consult authoritative native terminal state and companion call state; never close all open tools/turns as successful just because the stream restarted. Existing code does that today. [B11, N9]
- A `bb.ui.requestInput` tool detaches: bb promptly returns a waiting notice and later sends a system message through normal steer/new-turn behavior. Return that notice to the native model immediately. Do not wait for the phone form response inside the native tool callback. After detachment a native interrupt no longer aborts the pending form, and a failed detached result only steers an active thread and never starts a turn; document both and test them. [B12]
- `update_environment_directory` must update bb state and use the new cwd on the next turn via the migration above. Do not claim the active native session moved in place. Preserve the server's path validation and foreign-managed-worktree refusal. [B2]

### Cancellation, reconnect and restart

Native turn interrupt cancels that turn's calls while retaining the session binding/catalog for the next turn. When bb stop actually detaches its runtime, release, discard, bridge disposal or plugin reload removes an attachment, revoke that binding and settle its waiters; the next session construction must reattach before prompting. Test stop-then-next-turn in both retained-session and reconstructed-session paths. For dispatched bb calls emit existing `notifications/cancelled` with the original reverse request ID; late results cannot cross owner generations. Release should release bb ownership without interrupting unrelated native sessions. Do not wait indefinitely for callbacks during detach. [B13]

Preserve the existing runtime health refresh and service reattachment fix. A replaced service/plugin/Location generation invalidates old execution capabilities (binding step 9). After eviction or reload, a running step keeps the old service graph but its RPC is closed and new calls route to the latest registration: a claimed call whose side effect completed cannot deliver its result and must settle as uncertain. Restore catalogs on explicit ownership reattachment before new work, not by replaying observed historical tool events. Redacted UI/context data must never be reconstructed into executable tool arguments. [B10, B14, N16]

Plugin activation keeps only the unchanged prefix of the ordered plugin list (discovered directory plugins sorted by path, then configured packages in config order), so editing, adding or removing any plugin earlier in that order than the companion disposes it, drops its bindings, and interrupts in-flight calls. Installing or removing the companion likewise restarts plugins that sort after it; document that. [N11]

Two different guarantees must remain separate:

1. **In scope:** the adapter never automatically re-invokes the same claimed bb call after ambiguous loss. Known result delivery may be retried. Unknown outcomes are reported honestly; there is no exactly-once claim.
2. **Engine behavior:** current OpenCode automatically resumes suspended executions and marks old unfinished tools aborted. A model can then request a new semantically similar call. For a session whose `bbThreadId` marker has no live binding, a healthy companion strips bb tools from the catalog in `session.context`; it never blocks the session. A TUI fork of a bb session (which copies the marker) therefore runs native-only. The guard applies only when the marker equals the live binding root or the session is a verified descendant of it. An absent/failed companion cannot enforce even that. Strict engine-wide ownership/restart enforcement needs a separate core feature. Do not promise it as a plugin guarantee. [N10]

bb's server currently has no durable receipt ledger for tool side effects. Its endpoint checks host/thread ownership but resolves the globally registered tool by name. Both are existing baseline constraints. The new bridge must enforce its exact attached catalog; durable receipts or server-owned session authorization snapshots are separate work, not hidden prerequisites for this adapter. [B7, B13]

## Distribution and setup

### Companion package

Publish the companion as its own repository and package, released like any other OpenCode v2 server plugin. Repository `shuv1337/opencode-bb-tools`, npm package `opencode-bb-tools`. The package:

- Has a server entrypoint that the engine's `Host.resolve` finds. Declare `@opencode/plugin` as a peer dependency so the engine's runtime-provided modules are used, and bundle anything else (including `effect`) that released engine artifacts do not provide. Import `Tool.Error` only from the runtime `@opencode/plugin/effect/tool` so `instanceof` holds.
- Owns the `bb.tools.v1` protocol: a versioned `PROTOCOL.md`, the companion's own schemas, and golden JSON request/response fixtures for every method. It has no dependency on bb and knows nothing about bb servers, credentials or plugins beyond this protocol.
- Carries the real-engine test suite (scripted model, temporary HOME/XDG, pinned stock OpenCode and Shuvcode artifacts) with a small fake bridge client standing in for bb.
- Uses semver: protocol-breaking changes bump the major version and the `hello` protocol range. Releases are tagged and published from the companion repository's own CI. It is never built by bb's Turbo pipeline.

Install on each engine host as the engine's service user:

```sh
opencode plugin add opencode-bb-tools    # or: shuvcode plugin add opencode-bb-tools
```

Both npm registry and Git specifiers are accepted, so a Git specifier (`github:shuv1337/opencode-bb-tools#vX.Y.Z`) works before npm publication. The command installs through the engine's npm service and writes the spec into that engine's global config. Use the CLI that matches the engine's `appId`; a stock `opencode` CLI writes stock config, not Shuvcode's. Config changes are watched; confirm pickup with `hello`, not by assuming a reload. Upgrades use `plugin check|update`; removal uses `plugin remove`. Pin a version in the spec to control rollouts.

This retires the earlier bb-side packaging design: no bytes embedded in `host.js`, no checked-in generated bundle, no bb installer writing into engine plugin directories, and no owner refcount across bb installs. The engine's npm install owns the files.

### bb plugin role

`plugins/provider-opencode` consumes the companion but never ships it:

- Carries its own plugin-local schemas for `bb.tools.v1`, with a conformance test against the companion's golden fixtures, vendored at a pinned companion version (no runtime dependency on the companion package). The provider declares the protocol range it supports.
- Reports status per machine: companion detected or not, version, protocol range, install path/digest from `hello`, duplicate registrations, and rich-failure probe result. Expose this read-only status through typed plugin RPC, a `bb opencode tools status --machine <id> [--json]` CLI command, SDK access via `callRpc`, and the plugin's settings UI, together (per AGENTS.md CLI/SDK/UI parity). Follow `plugins/keep-awake/server.ts`, `host.ts` and `contract.ts` for the public patterns; do not copy keep-awake's `app.tsx`, which imports private `@bb/shared-ui`. The public SDK has no drawer or form primitives, so a settings UI needs its own `bb.app` manifest entry, a React dependency strategy that survives `--omit=dev`, JSX/DOM tsconfig settings, and an isolated DOM vitest project. Status works identically in explicit `OPENCODE_SERVER_URL` mode because it uses `hello` and `plugin.list`, not the filesystem.
- Explains and links the companion everywhere the user meets it: the plugin README (what it is, why it is separate, install/upgrade/remove commands per engine and `appId`, supported version range, remote-engine note), the `opencode-tools` skill, the relevant `bb-guide-*` entries, the persistent absent-companion warning, and the settings UI, each with the companion repository URL and the exact `plugin add` command for the detected engine.

Detect duplicates rather than prevent them: if more than one `bb.tools.v1` provider is registered (for example both an npm and a Git spec), status reports it and attachment fails with the list of specs to remove. RPC routing is last-registration-wins. [N11]

### Compatibility policy when the companion is absent

bb always injects `update_environment_directory`, so the catalog is never empty; a nonempty-catalog hard fail would break every OpenCode thread on hosts that upgrade the provider from `@main` without installing the companion. Instead:

- **Companion absent:** keep today's native-only behavior and turn the existing dropped-tools warning into a persistent `provider.warning` that names the companion, links it and gives the install command. The server keeps sending the environment-directory instruction; suppressing it would need provider-to-server capability reporting, a core change this plan does not make.
- **Companion present but outside the supported protocol range**, or the host has opted in with a per-host “bb tools required” provider setting: fail before starting the turn with an actionable setup error.
- Never silently discard tools while claiming they are available.

Companion removal (via the engine's `plugin remove`) unloads it, which changes the generation; the bridge detects this at the next binding check and reverts to the absent-companion behavior. Test removal during a call: it settles uncertain. On our fork the legacy ACP OpenCode provider stays disabled; stock bb users must keep selecting native `opencode`, not `acp-opencode`.

## Implementation milestones

Paths below are relative to bb unless marked **Companion** (the standalone companion repository) or **Shuvcode**. Proposed files do not exist yet. Creating and publishing the companion repository and package is an outward-facing step that needs explicit approval at that time; until then, develop it as a local repository and install it by path or Git specifier.

### 0a. Kill test (1–2 days)

Create the companion spike as a local standalone repository and a disposable real-engine fixture in it. Drive it from a bb bridge running against that engine. Use a scripted test model and temporary HOME/XDG roots; never the elected production service. Pin actual released stock OpenCode and Shuvcode versions, starting with 2.0.15 and 2.0.15-shuv.1 (and 2.0.16 or mark it unverified); test older supported versions before retaining a broader minimum.

Prove only the load-bearing assumptions:

- One actual model request invokes a registered bb fixture tool through companion RPC -> bridge reverse RPC -> result -> native continuation, with registration complete before the prompt.
- The packed companion, installed through the engine's own `plugin add` (Git or tarball specifier) into a temporary HOME, loads in both the SEA and Bun-compiled engine artifacts, with `@opencode/plugin` resolved to the runtime-provided module and its other dependencies bundled; typed `Tool.Error` metadata survives. Confirm the config watcher picks up the new plugin without a service restart, or document the restart.
- Two identical same-owner companion calls inside a single Code Mode execution are both rejected by the direct-origin guard, not collapsed onto one pending call.
- Whether the environment-directory migration can fork across Locations, or must fall back to `SESSION_NOT_RESTORABLE`.

If any of these fail, record the precise failed case and design only the minimal required engine seam. Do not port historical dynamic-tools code on speculation.

#### 0a results (2026-09-24 PDT)

Passed on both Shuvcode 2.0.15-shuv.1 and stock `@opencode/cli@2.0.15` (Bun-compiled Linux x64 binaries), with a scripted OpenAI-compatible mock model and isolated HOME/XDG roots. Harness: `plugins/provider-opencode/src/bridge/companion-engine.live.test.ts` on bb branch `spike/opencode-bb-tools-0a`, skipped unless `BB_OPENCODE_LIVE_ENGINE` (and `BB_OPENCODE_LIVE_APP` for stock) is set. Companion spike: local repository `~/repos/opencode-bb-tools`.

- **Round trip:** a model call to canonical `bb_echo` reaches the companion, the bridge claims it and sends reverse `item/tool/call` (`providerNativeIds: true`), the fake bb host answers, and the model's next request carries the result. The model only ever sees canonical names; internal `bbt_*` names never reach it. Companion `control` RPC events route to the per-session pump through `data.sessionID`.
- **Loading:** `plugin add git+file://…#<sha>` works on both engines with no build step (TypeScript source, dependencies installed by the engine's npm service), and the running engine picks it up without a restart. The shipped binaries provide no plugin modules: the companion uses its own `@opencode/plugin`, `@opencode/schema` and `effect@4.0.0-rc.112`. A local-directory plugin needs a root `server.ts`; a directory that lacks one at startup is not re-picked up later.
- **Typed failures:** a companion-built `Tool.Error` fails the engine's `instanceof` check and loses metadata. Rebuilding the error in `execute.after` with `event.error.constructor` (the engine's class) preserves it; verified in `session.tool.failed` on both engines. Degraded failures carry every text block plus the omitted-image marker.
- **Direct origin:** the first `execute.before` event per call ID records the name the model called. A direct call records the canonical name exactly once; Code Mode records `execute` first. Shuvcode exposes direct tools inside Code Mode (`tools.bbt_b1_0`); both same-owner inner calls were rejected and nothing reached bb. Stock 2.0.15 does not expose direct tools inside Code Mode. This replaces the context-API lookup in binding step 6.
- **Environment migration:** fork cannot change Location; `session.move` can, and history survives. bb tools disappear after the move until reattached at the new Location (see Environment directory migration).
- **Harness notes:** the first model request per session is a title request without tools; start engines with `--port 0` so consecutive engines do not reuse a keep-alive socket.

### 0b. Complete the composition proof

Extend the fixture to cover: typed failure; successful image content; the degraded failure form on stock engines; cancellation and stop-then-next-turn in retained and reconstructed paths; bb stop during a claimed call; SSE overflow during a pending call (the call survives and delivers its result); a turn boundary during a pending child call; same-name/different-schema catalogs in two same-directory sessions; unrelated session denial; an imported session whose `parentID` is the bound root (rejected); alias execution; a native child; a background subagent after its turn ends (typed rejection); an independent fork; a TUI fork of a bb session (native-only, not blocked); attach takeover by a restarted bridge; and hot reload, including an earlier-sorted plugin changing during a bb call (settles uncertain, never re-dispatched, reattach before next prompt). Using a short injected `LocationActivity.layer({timeToLive, sweepInterval})`, cover a bb call in flight across the TTL (interrupted and settled uncertain on stock engines; completes normally with 1b), an idle session followed by a next turn, and a Location reload between turns. Prove callbacks remain cancellable while event processing continues, native canonical-name denies hold, and results over 50 KiB are not natively truncated. Capture compaction/generation model inputs to prove no companion or foreign definitions leak through auxiliary hooks.

Passing primitive tests below is evidence for attempting this milestone, not a substitute for it. Rich-failure fidelity is an exit criterion of milestone 1b, not of milestone 0.

### 1. Implement the companion contract and lifecycle

**Companion:** create `src/index.ts`, `src/tool-registry.ts`, `src/tool-broker.ts`, `src/protocol.ts`, their tests, `PROTOCOL.md`, golden fixtures under `fixtures/bb.tools.v1/`, the real-engine suite with its fake bridge client, a README, and release CI (pack, test against pinned engines, publish on tag). Use runtime-provided Effect plugin APIs, schemas, generation/claim state and scoped disposal. Keep native auth material out of session metadata, logs and events. Test binding, schema rejection, internal aliases, catalog revisions, children/forks, attach takeover, cancellation, idempotent terminal-result delivery and settled-record retention. Register finite negotiated budgets and test explicit overload errors.

**bb:** create plugin-local `src/tool-bridge-contract.ts` (bb's own schemas for the protocol) and a conformance test against vendored companion fixtures in `src/fixtures/bb-tools-v1/`, with the pinned companion version recorded beside them. No new directories are outside the plugin's existing tsconfig/vitest scope, and no new imports affect `public-sdk-only.test.ts`.

Do not add core/schema/database migrations to Shuvcode for this milestone. New code is the companion, not a replacement engine tool registry.

### 1b. Shuvcode engine patches: rich failures and in-flight tool activity

Two bounded Shuvcode fork patches, carried across upstream syncs. The rich-failure part raises fidelity; it is not a new session-tool registration API and does not block ordinary-call parity. The same deficiency exists in latest inspected upstream: `packages/schema/src/tool.ts`, `packages/core/src/session/runner/step.ts` and `publish-llm-event.ts` are identical for this behavior.

Extend the public typed `Tool.Error` with optional canonical content. Route failure content through the same truncation (`step.ts:121–126`), `normalizeImages` (`core/tool.ts:131–150`) and request image budget / modality substitution (`session/model-request.ts:112–180`, which today inspects only `content` results) as successful output, then pass it through `step.ts`'s typed error catch into `publisher.failTool`. Make `core/tool/runtime.ts:36–43` recognize a structural `_tag: "Tool.Error"` and carry content, rather than rewrapping non-`instanceof` failures as message-only. The existing failed event and message projection already support optional content; preserve it into history and subsequent model requests. Do not hide content in arbitrary metadata: that bypasses success-path media normalization/bounds and requires permanent reconstruction hooks.

**Tool calls in flight keep their Location active.** Today `LocationActivity` (`packages/core/src/location-activity.ts`) refreshes a Location only on durable session events. After 60 minutes without one, its sweep interrupts active executions (`reason: "inactivity"`) and evicts the services, even when a tool call is still running. Tool progress and plugin RPC are not durable events. Fix it in the engine, for every tool rather than only plugin tools:

- Track in-flight tool calls per session with a scoped lease acquired around every tool execution in `packages/core/src/tool/runtime.ts` (`Effect.acquireRelease`, so success, failure, interruption and defects all release). Expose the count through `SessionExecution` (or a small `ToolActivity` service beside it).
- In the `LocationActivity` sweep, an expired Location with any active session holding a lease is re-touched and neither interrupted nor evicted. Idle eviction resumes after the last lease releases and a full TTL passes.
- Abandoned calls are still bounded: bb's owner heartbeat and the companion's detach/revocation cancel waiting bb calls, which releases their leases. Native tools keep their own timeouts.
- Add `packages/core/test/location-activity.test.ts` cases with a short injected TTL: a tool in flight across the TTL is not interrupted and its result is delivered; eviction happens one TTL after it completes; a failed, interrupted or defecting tool releases its lease; a Location with no in-flight tools still evicts on schedule. Add a `session-execution.test.ts` case for lease accounting.

Exact Shuvcode change targets:

- Location activity: `packages/core/src/location-activity.ts`, `packages/core/src/session/execution.ts` (or a new `ToolActivity` service beside it), and the lease in `packages/core/src/tool/runtime.ts`. [N16]
- Schema/core: `packages/schema/src/tool.ts`, `packages/core/src/tool.ts`, `packages/core/src/tool/runtime.ts`, `packages/core/src/session/runner/step.ts`, `packages/core/src/session/runner/publish-llm-event.ts` (including the hosted-tool error path at `:474–484`), `packages/core/src/session/runner/to-llm-message.ts`, `packages/core/src/session/model-request.ts`, `packages/core/src/session/compaction.ts` (`:302–308` emits only `[Tool error]: message`).
- AI: `packages/ai/src/schema/messages.ts`, `packages/ai/src/tool-history.ts`, `packages/ai/src/tool-runtime.ts`, and `packages/ai/src/protocols/{shared,anthropic-messages,open-responses,openai-chat,gemini,bedrock-converse,mistral-chat}.ts`.
- AI SDK adapter: `packages/core/src/aisdk.ts` maps `error` to `text` (losing error meaning, `:650–654`) and moves media to a trailing user message (`:497–517,549–575`); the AI SDK V3 provider type has no error-with-content variant. Choose an explicit representation (for example `error-text` plus the media attachment message) and fix the existing error→text downgrade.
- Explicitly out of scope unless chosen: MCP `isError` content (`core/tool/mcp.ts:78–85`) and native session-UI rendering of failure media (`session-ui/current-tool-state.ts:27–30`). State the decision in the feature. [N15]

AI lowering is part of this feature. Anthropic, OpenAI Responses, OpenAI Chat, Gemini, Bedrock, Mistral and the AI SDK adapter currently turn error results into strings. Add an explicit typed error-with-content representation and protocol mappings preserving error semantics and media where supported. Where a model protocol has no native error marker, retain an explicit error text/status representation alongside media rather than claiming successful execution. **Land every lowering before or with the `step.ts`/publisher content forwarding**; otherwise un-updated encoders JSON-stringify `data:` URIs into prompts (`to-llm-message.ts:141–146`, `shared.ts:233–240`).

Per-protocol fidelity is not uniform. OpenAI Chat, Gemini and the AI SDK split media out of the tool result even on success (`openai-chat.ts:517–527`, `gemini.ts:429–447`, `aisdk.ts:497–517`), so failure ordering can only match success ordering. Anthropic `is_error` with image content and Bedrock `status:error` with an image are unverified. Publish a per-protocol matrix (error marker, media carried, ordering) backed by recorded request-body tests before claiming any cell.

Verify plain text errors remain backward compatible, rich failures survive restart/compaction/history, images are normalized/bounded once, oversized failure images are bounded, and engine UI remains failed. The companion's `hello` reports rich-failure support from a live probe, not from the engine version. No database migration or new HTTP session-tools wire protocol is expected. If actual public Protocol/HttpApi changes become necessary, regenerate clients as required by the Shuvcode repository instructions.

Extend native `packages/core/test/tool-registry.test.ts`, `tool-output.test.ts`, `session-runner-tool-events.test.ts`, `session-runner-message.test.ts`, `aisdk.test.ts`, and `packages/ai/test/provider/{anthropic-messages,openai-chat,gemini,open-responses-replay,open-responses-errors,bedrock-converse,mistral-chat}.test.ts` as relevant. Include actual serialized request-body assertions with a deterministic fake provider, including a regression test that no request body contains a `data:` URI inside a failed tool's text; do not require paid model calls for regression tests. Native checks run in their package directories (`bun run test ...`); `bun run check` is the repository's canonical lint/typecheck. Public-schema/server changes must follow native client-generation guidance.

### 2. Add the bb execution adapter

Modify `src/runtime/types.ts`, `src/runtime/http-runtime.ts`, `src/runtime/index.ts` and `src/runtime/fake-runtime.ts`; create `src/runtime/tool-bridge.ts` and `src/bridge/tool-calls.ts` with tests. Modify `src/bridge/bridge.ts` to retain full descriptors, attach on start/resume/fork, merge-update the fork marker, check binding generation before every `turn/start`/`turn/steer`, implement environment-directory migration, correlate reverse responses independently, settle calls locally at every abort the bridge causes, dispatch outside serial SSE processing, and revoke on stop/release/discard/replacement. Add bridge tests for: start in A, move to B, next turn succeeds with native Location B; unrelated sessions still refused.

Reuse existing wire contracts; no bb core change, server route, host-daemon protocol field or public SDK export is part of the design. If implementation appears to need one, stop and raise it as a blocker rather than changing core.

### 3. Fix presentation and recovery

Modify `src/delta-translation.ts`/tests, `src/runtime/events.ts` only if needed for companion wakeups, `src/bridge/test-support.ts`, and current bridge/recorded-conformance tests. Add sanitized current failed-tool fixtures under `src/fixtures/`. Preserve one row with supplied presentation and truthful pending/error/interrupted state. Reconcile terminal state without replaying execution, and never emit a turn boundary on resync while that turn has pending or claimed companion calls. Keep late-start, service replacement and credential-redaction regressions green.

### 4. Status, documentation and release

**bb:** modify `server.ts`, `src/host.ts` and package metadata; create a typed read-only status contract and tests, the `app.tsx` settings/status UI, and owning `skills/opencode-tools/SKILL.md`. Add the status CLI, SDK/plugin RPC and UI together. Use existing responsive drawer and typography conventions if a drawer is needed. If a settings UI is added, add `app.tsx` to the relevant `turbo.json` input lists (`turbo.json:583–585,686–688`); that is build configuration, not core product code.

Update the plugin README with a dedicated “bb tools companion” section: what it is and why it is a separate OpenCode plugin, the repository link, install/upgrade/remove commands for stock OpenCode and Shuvcode, the supported companion version/protocol range, remote-engine (URL mode) setup, and how to read `bb opencode tools status`. Update `src/runtime/IMPLEMENTATION-CONTRACT.md` and relevant `packages/templates/src/templates/bb-guide-*.md` entries according to `docs/cli-guide-and-skill.md`; the per-host “bb tools required” setting is a provider setting documented with the plugin. Document restart limits, the 60-minute Location ceiling, plugin-reload side effects, rollback, and child/background-subagent/cwd semantics.

Test the GitHub main/subdirectory source install against public bb/SDK with an isolated profile, then point it at an engine with the companion installed from its published (or pre-publication Git) specifier.

**Companion:** release `v0.1.0` after milestones 0–3 pass, with README (install, supported engines, protocol range, relationship to bb), `PROTOCOL.md`, changelog and tagged CI publish. Publishing requires explicit approval at that time.

### 5. Validate and roll out by host

After implementation verification, inventory shuvdev, shuvtest and shuvbot separately: actual service owner/HOME/appId/version, running bb build, native provider ID, OEM provider state, companion digest/protocol and capability handshake. Build/ship the reviewed plugin from main through normal deployment workflow. Install the companion with the engine's `plugin add` as the service user on each target host, pinning the released version, and run the acceptance matrix below; publish per-host results, not one combined all-clear.

The current request authorizes this investigation and plan, not execution of these deployment steps. Nothing in this plan is upstreamed.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Real execution | Scripted native model calls bb fixture once; server callback receives correct thread/project; model sees result; no dropped-tools warning |
| Compatibility | Provider upgraded, companion not installed → threads still run native-only with a persistent setup warning; incompatible companion or opted-in host → actionable pre-turn error |
| Tool definitions | Start/resume/fork preserve complete schemas; atomic invalid-catalog failure verified against `tool.list()`; running session remains construction snapshot; name-length and native/`execute` collisions explicit |
| Ownership | Two bb roots in one directory have different catalogs/results; unrelated, imported (including `parentID` = bound root) and native-fork sessions cannot execute; TUI fork of a bb session runs native-only, not blocked; bb fork carries its own `bbThreadId` and resumes after owners-file loss; spoofed epoch/root rejected; attach takeover fenced |
| Native children | Creation-verified descendant uses root bb ownership, current root `disallowedTools`, correct turn and nested row; background subagent after turn end gets typed rejection; independent bb fork gets fresh catalog; environment move semantics explicit |
| Results | Ordered text/image on success; failure per the published protocol matrix (rich where 1b is present, explicit degraded marker otherwise); empty success, malformed input/output, oversized result (>50 KiB not natively truncated, local and URL-mode engines), transport error; failed status and model/history/UI content preserved; no silent coercion into success |
| Interaction | `bb.ui.requestInput` waiting notice returns promptly; later response steers/starts normally; detached interrupt and failed-detached semantics as documented; ordinary long tool remains active with live owner |
| Permissions | Plan agent keeps bb tools; accept-edits/auto/full modes and canonical wholly-deny rules remain enforced; direct-origin guard rejects two same-owner inner Code Mode calls; no duplicate generic approval; auxiliary compaction/generation has no companion catalog |
| Cancellation | Native interrupt, bb stop/release/discard, bridge exit, companion reload and removal during a call settle once locally without awaiting a bb reply, and reject late replies; next ordinary turn still works; unrelated native work survives |
| Recovery | Lost/duplicate/overflowed SSE cannot dispatch twice or close a turn with pending calls; claimed unknown call never auto-reexecutes; result-delivery retry safe; Location eviction, Location reload and unrelated plugin reload are detected and reattached before the next prompt; call in flight across the Location TTL completes on engines with 1b, settles uncertain without it |
| Transcript | Exactly one native-derived bb row; supplied labels/icon/tint/suppress; failed/aborted state correct after resync and restart |
| Environment | Existing/new allowed directory works, invalid/foreign-managed path refused; next turn succeeds and its actual native Location matches bb's new environment |
| Distribution | Clean stock bb main/subdir Git install and bundled install work with no companion files in bb; companion installs via `plugin add` (npm and Git specifiers) on stock OpenCode and Shuvcode SEA and Bun artifacts; `plugin update` and `plugin remove` behave; duplicate npm+Git registration is reported and blocks attachment; bb status is correct locally and in URL mode; README, skill, warning and UI link the companion with the right install command |
| Protocol | bb's plugin-local schemas pass against the vendored companion golden fixtures; out-of-range companion version produces the actionable error |
| Deployment | All preceding smoke checks recorded separately for shuvdev/Linux desktop, shuvtest/Linux server, shuvbot/macOS; legacy ACP provider disabled on our fork |

## Validation commands and evidence

Already executed during investigation:

```sh
pnpm exec turbo run test --filter=@bb/provider-bridge-protocol
```

284 tests passed, 21 files. Log: `/tmp/bb-opencode-investigation-bb-protocol-tests.log`.

From Shuvcode `packages/core`, using its credential-scrubbing temporary HOME/XDG wrapper:

```sh
bun run test test/plugin/promise-tool.test.ts test/tool-registry.test.ts test/plugin/supervisor-reload.test.ts test/rpc-handler-errors.test.ts test/session-runner-tool-events.test.ts
bun run test test/tool-registry.test.ts test/mcp.test.ts --test-name-pattern 'passes complete call identity|replays empty sources|passes session IDs as MCP|configured MCP execution timeout'
bun run test test/session-runner.test.ts --test-name-pattern 'executes a tool renamed by a session context hook'
```

77 tests passed in the first run; five focused tests and one runner-alias test passed in additional runs (some primitive coverage overlaps). Logs: `/tmp/bb-opencode-investigation-native-tests.log`, `/tmp/bb-opencode-tool-api-tests.log`, `/tmp/bb-opencode-alias-tests.log`. These validate existing primitives, not implemented bb integration.

During implementation:

```sh
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode
git diff --check
```

The plan changes no bb core package, so core package checks are not expected; if one changes, that is a blocker to raise, not a check to add. The real-engine suite lives in the companion repository and runs there against pinned engine artifacts, with slow output kept in a log. bb's end-to-end check runs the provider against an engine with the companion installed from a pinned specifier. UI tests include the plugin status view and relevant compact drawer behavior. None of these replaces the live host matrix.

## Risks, rollback and readiness

The largest technical risk is composition: public plugin hooks work individually, but combined per-session registration, direct-origin enforcement, ownership and cancellation must pass milestone 0. Engine lifecycle (Location eviction, reload, prefix-based plugin restarts) is the second: bindings are ephemeral and must be revalidated before every turn. Rich failed results are a confirmed engine gap, addressed by milestone 1b; stock compatibility must be described accurately until that feature exists there. The largest distribution risk is a separately installed npm package loading correctly against the narrower runtime module surface of released engine builds (peer `@opencode/plugin`, bundled `effect`, `Tool.Error` identity). Version skew between the bb provider and the companion is the cost of separate releases; the `hello` protocol range, vendored golden fixtures and actionable out-of-range errors contain it. These are early gates in milestone 0a, not late deployment surprises.

Other concrete risks: schema/alias incompatibility between engine releases; multiple bridge owners on one shared service; plugin hot reload during a side-effecting call; unbounded image buffering; false success during event reconciliation; and confusing bb tool availability with global engine restart guarantees. The protocol, matrix and boundaries above address these directly.

Rollback, in order: drain/stop affected bb work and detach bindings; remove the companion with the engine's `plugin remove` (or pin an older companion version with `plugin add <pkg>@<version>`); then, if needed, install a provider pinned to a known commit (`git:https://github.com/shuv1337/bb@<sha>`), since installs otherwise track `@main`. Because an unbound marked session only has bb tools stripped (never blocked), an old provider with a leftover companion still runs native-only. Leave unrelated native config/plugins/sessions intact. Do not delete engine sessions/history to roll back tool integration. Restoring the old provider restores its known missing-tool behavior; report that limitation.

**Open decisions:**

None remain. Decided 2026-09-24: repository `shuv1337/opencode-bb-tools` and npm package `opencode-bb-tools`; milestone 1b fixes the 60-minute ceiling; nothing is upstreamed. Creating and publishing the companion repository still needs explicit approval at that step.

Milestone 0a passed on 2026-09-24 (see 0a results); ready to implement **milestone 0b**. The rest has concrete ownership and acceptance criteria, but full first-class capability must remain unclaimed until the combined and host tests pass. No product-policy decision is required to begin the isolated proof. If strict prevention of all native automatic continuation is required, that is a separate engine policy decision, not something to conceal in this adapter.

Independent review found and corrected: Code Mode inner-call identity collisions, auxiliary catalog leakage, canonical permission aliasing, cancellation followed by another turn, and rich failed-result loss through both Core and AI encoding. A second source-verified review (2026-09-24, `REVIEW-opencode-v2-bb-tools.md`) added: the absent-companion compatibility policy, environment-directory migration, local settlement of calls bb never answers, Location eviction/reload and plugin-prefix reload handling, duplicate-companion detection, the released engine runtime-module surface, the complete 1b target list, import-based ancestry spoofing, background subagents, native output truncation, and reuse of the existing `bbThreadId` marker. Follow-up decision (2026-09-24): the companion ships as a standalone OpenCode plugin repository/package installed with the engine's `plugin add`, and the plan makes no bb core changes; this replaced bb-side companion packaging and installation. The engine change is an explicit result of review, not an assumed capability. Tracked recurring gap: papercut `pc_0351eb1485f8`.

## Source evidence

Line references are pinned to the revisions above. `B` paths are in bb; `N` paths are in `/home/shuv/repos/shuvcode`.

| Ref | Source |
| --- | --- |
| B1 | `plugins/provider-opencode/src/bridge/bridge.ts:936–949,1161–1188,1314–1401`; `src/runtime/types.ts:214–246` |
| B2 | `apps/server/src/services/threads/thread-environment-directory.ts:32–54,140–208,260–371`; `thread-runtime-config.ts:92–106,220–236` |
| B3 | `plugins/provider-opencode/src/bridge/bridge.recorded-conformance.test.ts:407–427`; `bridge.conformance.test.ts:27–65`; `bridge.test.ts:644–679` |
| B4 | `apps/server/src/services/plugins/plugin-service.ts:783–815,2001–2087`; `packages/plugin-sdk/src/backend-contract.ts:1601–1654` |
| B5 | `packages/provider-bridge-protocol/src/requests.ts:31–64,95–110`; `apps/host-daemon/src/command-handlers/thread.ts:179–211,238–253` |
| B6 | `packages/provider-bridge-protocol/src/bridge-requests.ts:9–34`; `packages/agent-runtime/src/bridge-protocol-adapter.ts:575–605`; `runtime-thread-identity.ts:47–110`; `runtime-provider-requests.ts:150–237` |
| B7 | `apps/host-daemon/src/app.ts:525–532`; `server-client.ts:584–610`; `apps/server/src/internal/tool-calls.ts:57–126` |
| B8 | `packages/plugin-sdk/src/internal/host-policy.ts:3149–3251`; `backend-contract.ts:1187–1198,1626–1654`; `apps/server/src/services/plugins/plugin-service.ts:447–494`; `packages/provider-bridge-protocol/src/bridge-kit/bridge-tool-calls.ts:68–162`; `bounded-line-reader.ts:3–14`; `apps/server/test/services/plugins/plugin-tool-calls.test.ts:107–129` |
| B9 | `plugins/provider-codex/src/bridge/bridge.ts:734–767`; `plugins/provider-claude-code/src/bridge/bridge.ts:436–458`; `plugins/provider-pi/src/bridge/bridge.ts:255–271` |
| B10 | `plugins/provider-opencode/src/bridge/bridge.ts:576–579,853–867`; `src/runtime/events.ts:181–203`; `src/runtime/context.ts:13–60,130–143` |
| B11 | `plugins/provider-opencode/src/delta-translation.ts:676–721,856–950`; `delta-translation.test.ts:166`; `docs/provider-bridge-protocol.md:285–295` |
| B12 | `packages/plugin-sdk/src/backend-contract.ts:1057–1069`; `apps/server/src/services/plugins/plugin-tool-calls.ts:62–140`; `detached-tool-result-delivery.ts:18–76` |
| B13 | `packages/agent-runtime/src/runtime-provider-requests.ts:23–81`; `runtime.ts:1258–1283`; `packages/provider-bridge-protocol/src/bridge-kit/provider-tool-call-contract.ts:32–35`; `apps/server/src/services/plugins/plugin-tool-calls.ts:54–140` |
| B14 | `plugins/provider-opencode/src/bridge/bridge.ts:555–574,1024–1059`; `src/runtime/IMPLEMENTATION-CONTRACT.md:17–35` |
| N1 | `packages/plugin/src/promise/tool.ts:11–35,66–71`; `packages/schema/src/tool.ts:14–19,67–90`; `packages/plugin/src/promise/adapter.ts:615–621`; `packages/core/src/tool/runtime.ts:28–60` |
| N2 | `packages/plugin/src/promise/session.ts:25–35`; `packages/core/src/session/model-request.ts:216–232`; `packages/core/test/session-runner.test.ts` renamed-tool test |
| N3 | `packages/core/src/tool.ts:225–287`; `packages/core/test/tool-registry.test.ts` snapshot/identity/reload tests |
| N4 | `packages/plugin/src/effect/rpc.ts`; `packages/protocol/src/groups/rpc.ts:15–24` |
| N5 | `packages/core/src/rpc.ts:69–85,108–140,195–200` |
| N6 | `PLAN-fresh-v2-rewrite.md` Out of this cut; `packages/protocol/src/groups/session.ts:220`; no current dynamic-tool API matches in Core/Schema/Protocol/Client |
| N7 | `packages/protocol/src/groups/mcp.ts:25–58`; `packages/core/src/mcp/index.ts:337–353,624–650`; `packages/core/src/mcp/client.ts:272–283`; `packages/core/src/tool/mcp.ts:16–17,43–110` |
| N8 | `packages/protocol/src/groups/session.ts:227,358–365`; `packages/core/src/session.ts:273–276`; `packages/core/src/session/projector.ts:150–164`; `packages/core/src/tool/plugin/subagent.ts:185–198` |
| N9 | `packages/schema/src/session-event.ts:471–476,532–569` |
| N10 | `packages/core/src/session/execution/restart.ts:46–60,218–225`; `packages/core/src/session/runner/llm.ts:66–68,332–352`; `packages/core/src/plugin/hooks.ts:88–95`; `packages/core/src/plugin.ts:76–86` |
| N11 | `packages/protocol/src/groups/plugin.ts`; engine config roots via `config.get` at `packages/protocol/src/groups/config.ts:9–21` (`:37–48` is `config.update`, which cannot install plugins); `packages/core/src/config/plugin/source.ts:60–90,125–159,173–186`; `packages/core/src/plugin/source-directory.ts:7–32`; `packages/core/src/plugin/supervisor.ts:96–110,196–233`; `packages/core/src/plugin.ts:107–138` (unchanged-prefix activation); `packages/core/src/rpc.ts:83,111` (last registration wins) |
| N12 | `packages/core/src/session/model-request.ts:216–233,378–386` (identity-then-key matching); `packages/core/src/tool.ts:313` (alias keys skip name check); `packages/core/src/session/generate.ts:35–50`; `packages/core/src/session/compaction.ts:469–493` |
| N13 | `packages/core/src/tool.ts:230–232`; session context API at `packages/protocol/src/groups/session.ts:567–575` and `packages/core/src/session.ts:374–377` (`session/context.ts:130–134` is permission merge/snapshot); `packages/core/src/codemode/tool.ts:80–95,142–164`; called-before-execute ordering at `packages/core/src/session/runner/step.ts:116–128` and `bus.ts:314–401` |
| N14 | `packages/schema/src/tool.ts:61–65`; `packages/core/src/session/runner/step.ts:124–125`; `packages/core/src/session/runner/publish-llm-event.ts:87–90,327–340` |
| N15 | `packages/ai/src/schema/messages.ts:57–75,100–110`; `packages/ai/src/protocols/shared.ts:233–240`; `anthropic-messages.ts:776–782`; `open-responses.ts:584`; `openai-chat.ts:509–513,517–527`; `gemini.ts:417–428,429–447`; `bedrock-converse.ts:297–298,322`; `mistral-chat.ts:306–313`; `packages/core/src/aisdk.ts:497–517,549–575,650–654`; `packages/core/src/session/model-request.ts:112–180`; `packages/ai/src/tool-history.ts:77–79` |
| N16 | Location lifecycle: `packages/core/src/location-activity.ts:12,25,33–40,47–81`; `packages/schema/src/session-event.ts:523,708–712`; `packages/core/src/rpc.ts:109–112,131–137,177`; `location-services.ts:64–72`; `location-lifecycle.ts:41–47`; `location-service-map.ts:20–36`; `packages/server/src/handlers/location.ts:22–23`; bb `plugins/provider-opencode/src/bridge/bridge.ts:1206–1214` (health-only refresh) |
| N17 | Released runtime module surface: `packages/cli/vite.node.config.ts:124–181`; `packages/cli/src/node/plugin-runtime.effect.ts`; `packages/cli/script/build.ts:105–130`; `packages/core/src/tool/runtime.ts:36–43`; `packages/plugin/package.json` |
| N18 | Native output truncation: `packages/core/src/session/runner/step.ts:122`; `packages/core/src/tool-output.ts:13–14,65–66,91–94,118–120` |
