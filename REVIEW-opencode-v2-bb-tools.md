# Review: PLAN-opencode-v2-bb-tools.md

## Verdict

The architecture is sound. The source checks back up its core choices: an in-engine companion over authenticated plugin RPC, a direct-origin check, stripping companion tools from auxiliary hooks, canonical-name permissions, and never re-dispatching a call whose outcome is uncertain. Milestone 0 should not start until four things are settled:

- **Missing-companion policy.** As written, it breaks every OpenCode thread.
- **Environment moves.** `update_environment_directory` is blocked by the bridge's cwd binding.
- **Engine lifecycle.** Location eviction and plugin-reload semantics are not modelled.
- **Packaging.** The plan does not say how companion bytes get through a Git install.

Milestone 0 also needs a smaller scope. Its rich-failure scenario cannot pass on stock engines.

## Findings

### Critical

**C1. The missing-companion hard-fail breaks every OpenCode thread**
- **Section:** Distribution and setup (line 160); line 34.
- **Problem:** Line 160 says to fail the turn when the catalog is nonempty and the companion is missing, and to keep native-only behavior for zero-tool attachments. But bb always injects `update_environment_directory`, so the catalog is never empty. Once the provider ships from `@main`, every host without the companion goes from "warning" to "every turn fails". That contradicts "existing deployments retain their current behavior".
- **Evidence:**
  - `apps/server/src/services/threads/thread-runtime-config.ts:91-106` always prepends the tool; `:220-226`.
  - `thread-commands.ts:298,339` and `packages/agent-runtime/src/bridge-protocol-adapter.ts:186-188` add no filter.
  - `plugins/provider-opencode/src/bridge/bridge.ts:936-951,1187` only warn today.
  - Plan line 147 installs from `@main`.
- **Edit:** Replace line 160 with an explicit compatibility policy:
  - Companion absent: keep today's native-only behavior plus a persistent `provider.warning` and a setup hint, and drop the environment-directory instruction.
  - Hard-fail only when the companion is present but incompatible, or when a per-host "bb tools required" opt-in is set.
  - Add an acceptance row: "provider upgraded, companion not installed → threads still run".

### Major

**M1. `update_environment_directory` breaks the next turn because the bridge refuses a cwd change**
- **Section:** Results/UI (line 127); Acceptance "Environment" (line 234); Native children and bb forks (line 95).
- **Problem:** After a move, the daemon resumes the thread in the new environment with the new cwd. `assertOwned` then throws "is bound to <old>". It sits outside the `openSession` try/catch, so the error is never turned into `SESSION_NOT_RESTORABLE`. No milestone changes this.
- **Evidence:**
  - `plugins/provider-opencode/src/bridge/bridge.ts:1067-1103`; resume at `:1362`.
  - `apps/host-daemon/src/command-handlers/thread.ts:179-211,294-328`.
  - `apps/server/src/services/threads/thread-environment-directory.ts:140-142,176-178`.
  - `bridge.test.ts:620-641`.
- **Edit:**
  - Add a design item and milestone task for cwd migration. When bb legitimately changes the environment, create or fork a native session at the new Location and rebind (new binding and catalog, persisted owner), or return `SESSION_NOT_RESTORABLE` with a defined server fallback.
  - Keep refusing unrelated sessions.
  - Add a bridge test: start in A, move to B, the next turn succeeds with native Location B.

**M2. The runtime never replies to a cancelled reverse tool call, and resync closes turns (partially confirmed)**
- **Section:** Execution protocol (lines 110-116); Results/resync (line 125); Cancellation (lines 131-133).
- **Problem:** When bb cancels a reverse `item/tool/call`, it sends no result and no error. This happens on stop, on detach, on `notifications/cancelled`, and on every `turn/completed` the bridge emits. `reconcileAfterResync` closes the turn as `completed`, so an SSE overflow during a long bb call aborts the server-side plugin call. The bridge then waits for a reply that never comes. The owner heartbeat does not bound this, because the bridge is still alive.
  - Already covered: line 125 forbids closing tools as successful on resync, and line 133 says not to wait indefinitely during detach.
  - Not covered: the no-reply rule in general.
- **Evidence:**
  - `packages/agent-runtime/src/runtime-provider-requests.ts:216-233` (early return when aborted).
  - `runtime.ts:334-335`, `:1258-1263`, `:1273-1283`, `:2216`.
  - `plugins/provider-opencode/src/delta-translation.ts:676-721`.
  - `src/runtime/events.ts:193-199`.
  - `apps/host-daemon/src/app.ts:525-532`.
  - `plugin-tool-calls.ts:79-82`.
- **Edit:**
  - State that bb never replies to a reverse call it cancels. Whenever the bridge emits a turn boundary, sends `notifications/cancelled`, or handles interrupt, stop or detach, it must settle that turn's companion calls locally: cancelled if never dispatched, uncertain if claimed.
  - Resync must not emit a turn boundary while companion calls are pending or claimed.
  - Add tests for: bb stop during a claimed call; SSE overflow during a pending call (the call survives and delivers its result); and a turn boundary during a pending child call.

**M3. The plan does not model Location eviction and generation replacement**
- **Section:** Session binding steps 1-4 (lines 77-80); Results (line 122, "Do not impose a short ordinary-tool deadline"); Cancellation (lines 129-133).
- **Problem:** Three effects, all from the engine's 60-minute Location TTL:
  - **Hard ceiling on tool duration.** The engine evicts a Location after 60 minutes without durable session events and interrupts active executions there (`reason: inactivity`). Tool progress and plugin RPC are ephemeral and do not count as activity, so any bb call longer than 60 minutes is interrupted.
  - **Silent binding loss.** An idle, retained bb session loses its companion binding. `refreshRuntime()` checks only `health()` before `turn/start` and `turn/steer`. `LocationServiceMap.reload` has the same effect.
  - **Undeliverable results.** After eviction or reload, a running step keeps the old service graph, but its RPC is closed and new calls route to the latest registration. A claimed call whose side effect already completed cannot deliver its result.
- **Evidence (Shuvcode at `be4c643d671b`):**
  - `packages/core/src/location-activity.ts:12,25,33-40,47-81`.
  - `packages/schema/src/session-event.ts:523,708-712`.
  - `rpc.ts:109-112,131-137,177`.
  - `location-services.ts:64-72`.
  - `location-lifecycle.ts:41-47`.
  - `location-service-map.ts:20-36` and `server/src/handlers/location.ts:22-23`.
  - bb `bridge.ts:1206-1214`.
- **Edit:**
  - Name Location eviction and Location reload as events that change the generation.
  - Before every `turn/start` and `turn/steer`, call `hello` plus a binding check (generation, epoch, catalog digest) and reattach from retained descriptors if it fails.
  - Document the 60-minute ceiling, or add "a running plugin tool keeps its Location active" to the 1b engine work.
  - Report late results as undeliverable, and give the model an explicit uncertain-outcome failure.
  - Add acceptance tests using a short injected `LocationActivity.layer({timeToLive, sweepInterval})`: a bb call in flight across eviction, an idle session followed by a next turn, and a reload between turns.

**M4. Unrelated plugin changes reload the companion, and the plan has no policy for mid-turn reloads (partially confirmed)**
- **Section:** Session binding step 7; Cancellation (line 131); Milestone 0 hot reload.
- **Problem:** Plugin activation keeps only the unchanged prefix of the plugin list. Directory plugins are sorted by path, so editing, adding or removing any plugin that sorts before the companion disposes it. That drops its bindings and interrupts in-flight calls. The plan handles reload only as a companion-triggered event and reattaches at the next session construction. It never says whether the rest of the current turn runs with an empty catalog or fails at the guard.
- **Evidence:**
  - `packages/core/src/plugin.ts:107-138`.
  - `plugin/source-directory.ts:13-20`.
  - `plugin/supervisor.ts:196-225`.
  - `session/context.ts:118-145`.
  - `tool.ts:224-282`.
- **Edit:**
  - Add a "generation change during a turn" rule. On a generation mismatch, reattach all live bindings immediately. The `session.context` hook fails the step with an explicit "bb tools reattaching" error rather than exposing an empty catalog. State whether the turn is interrupted or continues.
  - Add a milestone-0 test in which an earlier-sorted plugin changes during a bb call. The call must settle as uncertain, never be re-dispatched, and trigger a reattach before the next prompt.
  - Document that installing or removing the companion restarts plugins that sort after it.

**M5. The "versioned companion directory" layout loads duplicate companions**
- **Section:** Distribution (line 154).
- **Problem:** Discovery loads every child directory and every `.ts`/`.js` file under `plugin/` and `plugins/`, with no dotfile or temp-name filtering, and watchers hot-reload them. Leftover version directories, or staging directories next to the target, would each load. For duplicate plugin IDs, the first in boot order wins, so an old version can stay active. RPC uses the last registration, so a stale copy can take over `bb.tools.v1` routing without notice.
- **Evidence:**
  - `plugin/source-directory.ts:7-32`.
  - `config/plugin/source.ts:60-90,127-133,173-186` (the revision is computed from the mtimes of the entrypoint and `package.json`).
  - `plugin/supervisor.ts:96-110`.
  - `rpc.ts:83,111`.
- **Edit:**
  - Use one stable discovered entry: a fixed name such as `plugins/bb-tools/`, or a stable symlink to a versioned store outside the discovered roots.
  - Stage outside the discovered roots and swap with a single rename, making sure the entrypoint or `package.json` mtime changes.
  - `hello` reports the companion's own path and digest. Fail attachment if more than one `bb.tools.v1` provider is present.
  - Add an installer test: exactly one companion appears in `plugin.list` after upgrade, downgrade, and an interrupted install.

**M6. A Git install cannot produce a generated companion, and the packaging citations are wrong (partially confirmed)**
- **Section:** Distribution (lines 150-156); Milestone 4 (lines 206-212).
- **Problem:**
  - A `git:` install runs `npm install --ignore-scripts --omit=dev`, then fixed server-side esbuild steps. It never runs Turbo, `prepare:bundled`, `stage-assets.mjs`, or package scripts.
  - Remote hosts receive only the digest-verified `dist/host.js`.
  - `prepare-plugin-runtime.ts` belongs only to the bundled path, and this plugin is also bundled (`plugins/bb-official.json:57`), so there are two build paths.
  - Milestone 4's "generated assets stay gitignored; add Turbo producer tasks" can never work on the Git path.
  - The plan does already gate this as a milestone-0 proof and flags it as the largest distribution risk.
- **Evidence:**
  - `apps/server/src/services/plugins/git-plugin-dependencies.ts:9-18`.
  - `managed-plugin-artifacts.ts:255-316`.
  - `packages/plugin-build/src/build-plugin-host.ts:357-383` (single bundle, `zodResolutionPlugin`).
  - `plugin-runtime.ts:1142-1190`.
  - `apps/host-daemon/src/plugin-host-artifact-cache.ts:7-8`.
  - `packages/plugin-build/src/cli.ts:6-19`.
  - `turbo.json:968-972`.
- **Edit:**
  - Name both paths explicitly.
  - Require the companion to reach hosts as opaque bytes embedded in `host.js`: a text-loaded file or a checked-in TS string module. Never import it as executable code, or it would be rebundled, zod-rewritten, and ship duplicate `effect`/`@opencode/plugin` copies.
  - Add a guard test that the committed build matches its source.
  - State that no `plugin-build` change may be required, because stock bb 0.43.4 servers would not have it.
  - Remove the gitignored/Turbo guidance for the companion.

**M7. Companion files fall outside the typecheck and test scope but inside the public-SDK scan (partially confirmed)**
- **Section:** File locations in milestones 0 and 1 (lines 170, 178); Validation (lines 260-266).
- **Problem:**
  - `companion/` and `test/companion-engine/` are not in the tsconfig `include` (ES2022 only, no DOM or JSX) or the vitest `include`.
  - `public-sdk-only.test.ts` scans the whole plugin directory and would reject `@opencode/plugin` and `effect` imports.
  - The root `turbo.json` input lists for cross-package suites cover only `package.json`, `src/**`, `server.ts` and `tsconfig.json`.
  - Correction to the lens finding: `#plugin-source` has a Node variant, so a Node worker can load it. The Manifest assertion uses a subset match, so adding a dependency alone does not break it.
- **Evidence:**
  - `plugins/provider-opencode/tsconfig.json` and `vitest.config.ts`.
  - `public-sdk-only.test.ts:7-14`.
  - `packages/plugin-sdk/src/testing/public-sdk-only.ts:22-35,79-94`.
  - `turbo.json:583-585,686-688`.
- **Edit:** In milestones 0 and 1:
  - Add a companion tsconfig or extend the existing one.
  - Add vitest includes or a dedicated Turbo task for the real-engine companion.
  - Extend the allowlist with the exact companion specifiers, and decide whether `@opencode/plugin` is bundled into the embedded bytes (preferred) or declared as a dependency.
  - Add `companion/**` and `app.tsx` to the relevant `turbo.json` inputs.
  - List the new task under Validation.

**M8. External plugins see a narrower runtime module surface, and `Tool.Error` identity is not preserved**
- **Section:** Results bullet 2 (line 121); Distribution (line 150); 1b (line 186).
- **Problem:**
  - In the SEA build, the virtual modules `@opencode/plugin` and `@opencode/plugin/effect` export only Agent, Command, Connection, Credential, Integration, Model, Plugin, Provider, Reference and Skill. There is no Rpc, Tool, Location or Mcp.
  - `effect/tool` exports only `Error`, `promise/tool` exports nothing, and `effect` itself is not provided.
  - The Bun-compiled build provides no virtual modules at all.
  - `core/tool/runtime.ts:36-43` rewraps any failure that is not `instanceof Tool.Error` as a message-only error. A bundled `@opencode/schema` copy therefore silently loses metadata and any future rich content, and a version-number gate would not detect it.
- **Evidence:**
  - `packages/cli/vite.node.config.ts:124-181`.
  - `packages/cli/src/node/plugin-runtime.effect.ts`.
  - `packages/cli/script/build.ts:105-130`.
  - `packages/core/src/tool/runtime.ts:36-43`.
  - `packages/plugin/package.json` (exports point at `src/*.ts`, `files: ["dist"]`).
- **Edit:**
  - Milestone 0 requirement: import `Tool.Error` only from `@opencode/plugin/effect/tool`, use only names present in the runtime modules, and pass a plain `PortableDefinition` for Rpc.
  - Test typed-failure metadata on both the SEA and Bun artifacts.
  - Add a live rich-failure probe to the `hello` handshake instead of a version-only gate.
  - Add `core/tool/runtime.ts` to the 1b targets: recognize `_tag: "Tool.Error"` and carry content through.
  - Document which `effect` copy the companion bundles.

**M9. The 1b change-target list is incomplete**
- **Section:** 1b (lines 186-192); N15.
- **Problem:**
  - Line 190 lists only four protocols that stringify errors. Missing from the targets:
    - `bedrock-converse.ts` (`:297-298,322`).
    - `mistral-chat.ts` (`:306-313`).
    - `core/src/aisdk.ts`. At `:650-654` it maps `error` to `text`, which loses the error meaning; it moves media to a trailing user message (`:497-517,549-575`); and V3 of the AI SDK provider type has no error-with-content variant.
    - `core/tool/runtime.ts`.
    - `session/model-request.ts`: `unsupportedParts` and `boundImages` inspect only `content` results (`:112-180`), so failure images would bypass the 25 MiB budget and modality substitution.
    - `ai/src/tool-history.ts:77-79`.
  - Truncation (`step.ts:121-126`) and `normalizeImages` (`core/tool.ts:131-150`) are wired only on the success path.
- **Edit:**
  - Add these files, with their tests (`packages/ai/test/provider/{bedrock-converse,mistral-chat}.test.ts`, `packages/core/test/aisdk.test.ts`).
  - Choose an explicit AI SDK representation (for example `error-text` plus the media attachment message), and fix the existing error→text downgrade.
  - Require failure content to go through truncation, `normalizeImages` and the request image budget, and add a test for an oversized failure image.
  - Before or alongside the `step.ts`/publisher content forwarding, land every lowering. Otherwise un-updated encoders JSON-stringify `data:` URIs into prompts (`to-llm-message.ts:141-146`, `shared.ts:233-240`). Add a regression test that no request body contains a `data:` URI inside a failed tool's text.

**M10. An imported session with `parentID` gains ancestry authority**
- **Section:** Native children and bb forks (lines 89, 93); Acceptance "Ownership".
- **Problem:** The public `session.import` endpoint accepts a caller-supplied `info.parentID`, checks only that the parent exists, and persists a real child. An ancestry-only check therefore authorizes it, which contradicts line 93 ("imported ... cannot gain authority"). Exploiting this requires engine credentials. Forks are correctly excluded.
- **Evidence:**
  - `packages/protocol/src/groups/session.ts:239-254`.
  - `packages/core/src/session/transfer.ts:73,94`.
  - The same code exists upstream at `ff6b8c21`.
- **Edit:** Choose one:
  - (a) Declare authenticated engine access the trust boundary and drop "imported" from the guarantee.
  - (b) Authorize a descendant only if the companion observed its creation by a direct-origin-verified `subagent` call in an authorized ancestor (`subagent.ts:201` reports `progress.sessionID`), and add an acceptance case where an import with parentID = the bound root is rejected.

**M11. Background subagents outlive the owning turn, and no rule covers them**
- **Section:** Native children (line 91).
- **Problem:** `subagent` with `background: true` returns immediately and keeps running after the root turn ends. A bb call from it would carry either `turnId: null` (the runtime rejects it when no turn is active) or a captured stale `turnId`, which the runtime accepts unchecked.
- **Evidence:**
  - `packages/core/src/tool/plugin/subagent.ts:19-27,44-47,200`.
  - bb `packages/agent-runtime/src/runtime-provider-requests.ts:150-170,187-194`.
  - `bridge.ts:614-628`.
- **Edit:** Pick one, document it, and add a background-subagent acceptance case:
  - (a) Keep the bb turn open while bound background descendants run.
  - (b) Reject calls whose captured turn has closed with a typed error ("bb turn ended; bb tools unavailable to background subagents").

**M12. Successful bb results pass through native output truncation (critic finding, spot-checked)**
- **Section:** Results (line 122); Acceptance "Results" (line 228).
- **Problem:** Every successful local tool result passes through `toolOutput.truncate`. It cuts at 2,000 lines or 50 KiB, writes the full text to a file on the engine host, and inserts a path marker. That contradicts "do not silently truncate / negotiated budgets", leaves bb output on the engine host's disk, and gives a path that is meaningless for remote-URL engines. `truncate` skips results that already have `metadata.truncated` set.
- **Evidence:**
  - `packages/core/src/session/runner/step.ts:122`.
  - `packages/core/src/tool-output.ts:13-14,65-66,91-94,118-120`.
- **Edit:** Choose and document a policy:
  - (A) The companion sets `metadata.truncated: false` and relies on bb's own budgets.
  - (B) Accept native truncation and document the limits, spill location and retention.
  - Either way, add an acceptance case for a result over 50 KiB, on both a local and a remote-URL engine.

**M13. The `bbThreadId` marker already exists and is copied into forks and children (critic finding, spot-checked; the plan acknowledges copied fork metadata at line 93)**
- **Section:** Session binding step 3 (line 79); Native children (lines 89-93); guard (line 138).
- **Problem:**
  - The bridge already writes `metadata: { bbThreadId }` on thread/start (`bridge.ts:1319`), persists the owners map (`:539-542,1711`), and refuses unmarked sessions (`:1067-1125`). "Add a marker / preserve metadata on adopted sessions" therefore describes a state that does not exist.
  - bb `thread/fork` (`:1385-1402`) never rewrites the marker, so every bb fork carries its source thread's ID. Native forks and children copy it too (`projector.ts:150-164`, `session.ts:273-276`).
  - Consequences: the proposed guard would block plain TUI forks, and marker-based logic identifies a bb fork as its source thread.
- **Edit:**
  - Reuse the existing marker and owners map.
  - On bb fork, merge-update the fork's metadata to the new `threadId`.
  - Define the guard as "marker equals the live binding root, or the session is a verified descendant of it".
  - Add acceptance cases: a TUI fork of a bb session runs native-only (not blocked), and a bb fork resumes after the owners file is lost.

### Minor

- **Milestone 0 requires a feature that 1b delivers, and the stock-engine degraded behavior is undefined (partially confirmed).**
  - Line 172 requires success:false with text plus an image on stock 2.0.15, and line 121 requires it in the vertical proof. But `Tool.Error` has no content field (`schema/tool.ts:61-65`), and neither `step.ts:124-125` nor `publish-llm-event.ts:327-341` forwards content.
  - Lines 11 and 82 ("do not silently flatten" versus "text failures on stock") leave stock behavior undefined.
  - Edit: define the degraded form as ordered text plus a "[N image(s) omitted: engine lacks rich tool errors]" marker, advertised via `hello`. Move full fidelity to the 1b exit criteria.
  - Also consider splitting milestone 0 into a 1-2 day kill test (one round trip, Code Mode rejection, and the built artifact loaded from a temp HOME) followed by 0b/0c. The plan's own "Ready to implement milestone 0" (line 276) currently covers most of the acceptance matrix.
- **1b scope and fork cost (partially confirmed).** 1b adds Core/AI changes that exist only in the fork, with no upstream PR, which is a permanent rebase burden. Consider presenting 1b as a follow-up that raises fidelity rather than a prerequisite for parity, and record whether to propose it upstream, using MCP `isError` as the motivating second producer.
- **Compaction drops failure content.** `compaction.ts:302-308` emits only `[Tool error]: message`, yet line 192 claims rich failures survive compaction. Either add `compaction.ts` to the targets or qualify the claim.
- **Other consumers of the result union are unnamed.**
  - `ai/tool-runtime.ts:38-39`.
  - `ai/schema/messages.ts:108-109`.
  - The hosted-tool error path in `publish-llm-event.ts:474-484`.
  - `core/tool/mcp.ts:78-85` (MCP `isError` keeps only text).
  - `session-ui/current-tool-state.ts:27-30`.
  - State whether native UI fidelity is in scope.
- **Ordered-media claims are overstated per protocol (partially confirmed).** OpenAI Chat, Gemini and the AI SDK split media out of the tool result even on success (`openai-chat.ts:517-527`, `gemini.ts:429-447`, `aisdk.ts:497-517`). Anthropic `is_error` with an image, and Bedrock `status:error` with an image, are unverified; require recorded tests before claiming them. Add a per-protocol matrix, and reword the acceptance row to "ordered where the protocol preserves order for success".
- **Line 81 "the runner drops invented definitions" is only half true.** Matching is by identity, then by key (`model-request.ts:216-233`). An invented object stored under a registered name is kept. Hook alias keys also skip the `^[A-Za-z0-9_-]{1,64}$` check (`tool.ts:313`), while bb names have no length cap (`host-policy.ts:123`). Validate canonical names at attach time, including collisions with native tools and `execute`.
- **Registration and validation failures are silent (partially confirmed).**
  - Invalid registrations are only logged (`tool.ts:177-182,206-217`).
  - A transform that throws disables the whole plugin group (`state.ts`, `plugin.ts:182-215`).
  - An unconvertible schema disables validation (`tool/runtime.ts:9-18,76-77`).
  - Edit: after `reload()`, diff `tool.list()` against the expected set and roll back on mismatch. Transforms must never throw. The companion compiles and validates bb schemas itself.
- **Attach takeover is undefined (partially confirmed).** The plan never defines a second `attach` on an already-bound root, the fate of unclaimed old-epoch calls, or which methods require the capability.
  - Edit: fence takeover by requiring the current capability or an expired heartbeat. Settle old-epoch calls (unclaimed → "owner replaced", claimed → uncertain), never transfer them, and surface a warning.
  - The realistic case is a restarted bridge reattaching while the old heartbeat is still live.
- **Several bb installs can share one engine plugin directory (partially confirmed).** A dev bb and an installed bb share one per-user service (`IMPLEMENTATION-CONTRACT.md:14-17`, `docs/debugging-and-qa.md:3-8`), so one install's upgrade or removal hits the other. Edit: forward-only installs, a protocol range in `hello`, and a guarded remove (owner refcount, or `--force`).
- **The companion RPC can be shadowed (partially confirmed).** A project-local or co-loaded plugin can register `bb.tools.v1`, and the last registration wins. There is little real escalation, since such a plugin already runs arbitrary code. The actionable part is the duplicate detection in M5; no full threat-model section is needed.
- **The install target is resolved from bb's environment, not the engine's (partially confirmed).** `native-roots.ts:437-457` uses the bb daemon's environment and HOME. Prefer the engine's global config Directory entry from `config.get` (never the `~/.claude` or `~/.agents` roots), require the same UID, and accept no paths or bytes from the server.
- **Remote-URL detection is undefined.** Explicit `OPENCODE_SERVER_URL` mode does no filesystem scan (`IMPLEMENTATION-CONTRACT.md:16`), so line 158's "another filesystem" test cannot be evaluated. Never auto-install in URL mode; report status from `hello` and `plugin.list`, and print manual install instructions.
- **Rollback conflicts with the unbound-session guard (partially confirmed).** An old provider plus a leftover companion would block every marked session, and installs track `@main`. Order rollback as: detach, remove the companion, then install a provider pinned to `git:...@<sha>`. Narrow the guard to stripping the catalog and never blocking.
- **Removal cannot reach the bridge's in-memory bindings (partially confirmed).** Host-entry RPC runs in a forked worker, and the bridge is a separate `bridge-worker` process (`provider-registry.ts:34-46`, `plugin-host-manager.ts:2`). State that revocation happens through companion unload and the resulting generation mismatch, and test removal during a call.
- **Line 152 points at keep-awake's `app.tsx`, which uses private `@bb/shared-ui`** (`plugins/keep-awake/app.tsx:7-9`).
  - Copy only its `server.ts`, `host.ts` and `contract.ts` patterns.
  - The public SDK has no drawer or form primitives (`packages/plugin-sdk/src/app.ts:104-213`).
  - List the missing setup work: the `bb.app` manifest entry, a React dependency strategy that works under `--omit=dev`, JSX/DOM tsconfig settings, and an isolated DOM vitest project.
- **Detached `requestInput` semantics are incomplete.**
  - After detachment, a native interrupt no longer aborts the form.
  - Failed detached results only steer an active thread and never start a turn (`backend-contract.ts:1060-1066`, `plugin-tool-calls.ts:84-89`, `detached-tool-result-delivery.ts:62-64`).
  - Amend line 126, the Interaction row and the Cancellation row.
- **The direct-origin check costs O(history) per call.** The plugin `SessionDomain` exposes only the full `context` (`promise/session.ts:153-168`). Alternative: an origin record written by `tool.execute.before`, keyed by `(sessionID, messageID, callID)`.
- **Idempotency state has no retention bound (partially confirmed).** Define retention for settled records (until `pending` acknowledges them, or the epoch ends) and count them against budgets. A claim nonce is optional and improves availability only.
- **Plan and permission modes are misstated (critic finding).**
  - The provider modes are accept-edits, auto and full; plan is the native `plan` agent, which only denies `edit` (`declaration.ts:40-41,71,83`; `core/plugin/plan.ts:33-41`).
  - `ask` rules never gate plugin tools.
  - State the expected outcomes: bb tools remain available in plan mode, and only canonical wholly-deny rules remove them.
- **Child permission snapshots go stale (critic finding).** Children copy the root's permissions once, at creation (`session.ts:275`), and later root updates do not propagate to them (`bridge.ts:887-908`). Enforce the root's current `disallowedTools` in the companion executor for descendants as well, and test it.
- **MCP was not evaluated as a degraded fallback (partially confirmed).** Optional: record why a stdio MCP fallback for local engines is accepted or rejected, given C1.
- **The baseline is stale.**
  - npm `latest` for `@opencode/client` and `@opencode/plugin` is now 2.0.16.
  - Shuvcode `origin/integration-v2` is at `5e751cd0a`, with CLI branding changes only; the tag `v2.0.15-shuv.1` is still `be4c643d671b`.
  - No cited evidence is invalidated. Update the table, and either add 2.0.16 to the milestone-0 matrix or mark it unverified.

## Evidence citation corrections

| Plan ref | Issue | Correction |
|---|---|---|
| Line 156, `prepare-plugin-runtime.ts` / `stage-assets.mjs` | Bundled path only; Git installs never run it | Cite `git-plugin-dependencies.ts:9-18`, `managed-plugin-artifacts.ts:291-316`, `plugin-runtime.ts:1142-1190` |
| Line 152, keep-awake `app.tsx` | Imports private `@bb/shared-ui` | Limit to `server.ts`, `host.ts`, `contract.ts` |
| Line 22, "matching live origin/integration-v2" | Stale | `be4c643d671b` (tag `v2.0.15-shuv.1`); origin is now at `5e751cd0a` (CLI-only) |
| Line 23, npm latest 2.0.15 | Stale | 2.0.16 |
| N13, `session/context.ts:130-134` | Permission merge and snapshot, not a context API | `protocol/groups/session.ts:567-575`, `core session.ts:374-377`; ordering at `step.ts:116-128`, `bus.ts:314-401` |
| Line 81, "runner drops invented definitions" | Kept when stored under a registered name | `model-request.ts:224-233` |
| Line 93, "imported … cannot gain authority" | False under an ancestry-only check | `transfer.ts:73,94` |
| Line 190, list of error-stringifying protocols | Incomplete | Add Bedrock, Mistral, and `core/aisdk.ts` |
| Line 79, "add durable marker / adopted sessions" | The marker already exists | `bridge.ts:1319,1067-1125` |
| N11, used to locate the install target | `config.ts:37-48` is `config.update` | For engine roots, cite `config.get` at `protocol/groups/config.ts:9-21` |

## Confirmed strengths

- **bb-side facts.** Source checks back up B1 through B14 and the N1 through N15 line references. bb HEAD matches `190a1b2c6`, and the Shuvcode drift does not touch any cited path.
- **Design choices the source supports:**
  - A per-binding capability, because RPC transport auth is general and routing is last-registration-wins.
  - The direct-origin check, since `Tool.Called` is projected before the executor forks.
  - Stripping companion tools from the `session.context`, compaction and generate hooks.
  - Setting `permission` to the canonical name.
  - A reverse-request ID namespace that does not collide.
  - bb dispatch kept off the serial `session.work` queue, which would otherwise deadlock detach.
  - No re-dispatch of claimed calls whose outcome is unknown.
- **Scoping is correct:**
  - No `HOST_DAEMON_PROTOCOL_VERSION` bump.
  - No new server route.
  - No new public SDK exports.
  - HTTP cannot install plugins (`Config.Patch` allows only `shell`).
  - Failed events and projections already carry optional content, so 1b needs no DB migration.
  - An Effect-native companion is the right choice over the Promise adapter.
- **The CLI, SDK and RPC surfaces are feasible at SDK 0.5.9.** Multi-word CLI paths work, `opencode` is not a reserved command, `callRpc` gives SDK parity, and the Turbo filter names resolve.