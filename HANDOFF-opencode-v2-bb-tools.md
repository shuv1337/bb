# Handoff: bb tools for OpenCode v2

Written 2026-09-24 PDT. Read `PLAN-opencode-v2-bb-tools.md` first; it is the design of record. `REVIEW-opencode-v2-bb-tools.md` is the source-verified review behind the current plan.

## State

| Item | Where | State |
| --- | --- | --- |
| Plan + review | bb branch `plan/opencode-v2-bb-tools` (commit `01983871b`) | Committed, not pushed |
| Milestone 0a spike | bb branch `spike/opencode-bb-tools-0a` (on top of the plan branch) | Committed, not pushed |
| Companion spike | `~/repos/opencode-bb-tools` (local git repo, no remote) | One local commit, `374345cd0` |
| Stock engine for tests | `/tmp/oc-stock` (`npm i @opencode/cli@2.0.15`) | Temporary; reinstall if `/tmp` was cleared |

Milestone 0a passed on Shuvcode 2.0.15-shuv.1 and stock OpenCode 2.0.15. Results are recorded in the plan under “0a results”. Next is **milestone 0b**.

## Decisions already made (do not reopen)

- The companion is a standalone OpenCode plugin: repository `shuv1337/opencode-bb-tools`, npm package `opencode-bb-tools`, installed with the engine's `plugin add`. bb never ships or installs it. Creating the GitHub repo or publishing to npm needs explicit user approval at that step.
- No bb core changes (server, host daemon, agent-runtime, provider-bridge-protocol, Plugin SDK) and no `HOST_DAEMON_PROTOCOL_VERSION` bump. All bb work stays in `plugins/provider-opencode`. If a core change seems necessary, stop and raise it.
- Nothing is upstreamed. Shuvcode engine changes (milestone 1b: rich tool failures, and in-flight tool calls keeping a Location alive) are fork patches.
- Missing companion keeps today's native-only behavior with a warning; only an incompatible companion or an opted-in host hard-fails.

## What the spike contains

**bb (`plugins/provider-opencode`):**

- `src/runtime/types.ts`, `http-runtime.ts`, `fake-runtime.ts`, `index.ts`: `SessionHandle.rpc(rpcID, method, input)` over `client.rpc.call`, scoped to the handle's Location, and the `OpenCodeJsonValue` type.
- `src/bridge/bridge.ts`: on session construction, `attachBbTools` calls companion `attach`; on failure it falls back to the dropped-tools warning (now with a reason). `rpc.bb.tools.v1.control` events trigger `scheduleBbToolDrain` (outside the serial SSE queue), which reads `pending`, then per call `claim` → reverse `item/tool/call` (`providerNativeIds: true`, string IDs `oc-tool-N`) → `result`. `detachSession` settles outstanding reverse calls locally and calls `detach`.
- `src/bridge/companion-engine.live.test.ts`: real-engine suite (scripted OpenAI-compatible mock model, isolated HOME/XDG, real bridge, fake bb host). Skipped unless `BB_OPENCODE_LIVE_ENGINE` is set.
- `src/bridge/bridge.test.ts`: one assertion relaxed for the new warning text.

**Companion (`~/repos/opencode-bb-tools`):** `src/server.ts` (Effect plugin: `bb.tools.v1` RPC with `hello/attach/pending/claim/result/detach`, per-binding internal tool names `bbt_<binding>_<n>`, `session.context` aliasing to canonical names, compaction/generate stripping, `execute.before` origin tracking, `execute.after` metadata re-wrap), root `server.ts` entry, pinned deps `@opencode/plugin@2.0.15`, `@opencode/schema@2.0.15`, `effect@4.0.0-rc.112`.

## How to run

```sh
cd ~/repos/bb/plugins/provider-opencode
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode   # unit: 241 pass, live suite skipped

BB_OPENCODE_LIVE_ENGINE=~/.npm-global/lib/node_modules/shuvcode/node_modules/shuvcode-linux-x64/bin/shuvcode \
  pnpm exec vitest run --config vitest.config.ts src/bridge/companion-engine.live.test.ts > /tmp/oc-live.log 2>&1

BB_OPENCODE_LIVE_ENGINE=/tmp/oc-stock/node_modules/@opencode/cli-linux-x64/bin/opencode BB_OPENCODE_LIVE_APP=opencode \
  pnpm exec vitest run --config vitest.config.ts src/bridge/companion-engine.live.test.ts > /tmp/oc-live-stock.log 2>&1
```

Set `BB_OPENCODE_LIVE_KEEP=1` to keep the temp engine roots for inspection (engine logs are under `<root>/data/<appId>/log/`). Live diagnostics are written to stderr as `LIVE …` lines; the bridge test harness captures stdout as JSON-RPC, so never write diagnostics to stdout. Companion typecheck: `cd ~/repos/opencode-bb-tools && npx tsc -p .`.

Do not touch the user's running `shuvcode serve --service`; always use isolated roots.

## Gotchas learned

- Shipped engines are Bun-compiled and provide no plugin modules; the companion resolves `@opencode/*` and `effect` from its own `node_modules`. Keep `effect` pinned to the engine's exact version.
- A companion-built `Tool.Error` fails the engine's `instanceof` and loses metadata; the `execute.after` re-wrap with `event.error.constructor` is what preserves it.
- Local-directory plugins need a root `server.ts`/`index.ts`; if missing at engine start, adding it later is not picked up. `plugin add` accepts `git+file:///path#<sha>` and installs dependencies without running scripts.
- Plugin state and RPC registrations are per Location. `session.move` changes a session's Location and drops the binding; the bridge handle's `location` then goes stale.
- Shuvcode puts direct (`codemode:false`) tools inside Code Mode's `tools` object; stock 2.0.15 does not.
- The first model request per session is a title request with no `tools`; the mock branches on that. Start engines with `--port 0` or consecutive stock engines reuse a keep-alive socket and fail with `fetch failed`.
- `execute.before` for a direct call carries the name the model called (canonical); for Code Mode the first event is `execute`, then inner events use internal names with the same call ID.

## Spike shortcuts to replace in milestone 1/2 (not bugs in the design, just not built yet)

- No owner heartbeat, epoch, generation check, attach takeover fencing, or `hello` version negotiation in the bridge; `attach` silently replaces a previous binding for the same session.
- Only the root session is authorized; no descendant tracking via verified `subagent` calls, no background-subagent rule, no root `disallowedTools` enforcement in the executor.
- `origins` entries leak if a call is rejected before `execute.after` fires; settled-record retention and budgets are not implemented.
- Bridge does not settle companion calls at turn boundaries, interrupt, or `notifications/cancelled`; resync is not guarded against closing turns with pending calls; no binding recheck before `turn/start`/`turn/steer`.
- No environment-directory migration (`session.move` + handle Location update + reattach) in the bridge yet.
- `metadata.truncated: false` is not set, so native truncation applies to large bb results.
- No duplicate-companion detection, status RPC/CLI/UI, fixtures/`PROTOCOL.md`, or companion README/CI.

## Next: milestone 0b

Extend the live suite (plan section “0b. Complete the composition proof”). Suggested order, cheapest first:

1. Cancellation: native interrupt during a pending call; bb stop during a claimed call; stop-then-next-turn in retained and reconstructed paths.
2. Two same-directory sessions with same-name/different-schema catalogs; unrelated-session denial.
3. Native child via `subagent`; background subagent after its turn ends; imported session with `parentID` = bound root (must be rejected); TUI-style native fork (native-only, not blocked).
4. Hot reload: companion reload and an earlier-ordered plugin change during a bb call (settles uncertain, never re-dispatched, reattach before next prompt).
5. Location eviction via short TTL — note the TTL is an engine internal (`LocationActivity.layer`), so for binaries this may need a long wait or `POST /api/location/reload` as a proxy; record which.
6. SSE overflow/resync during a pending call; >50 KiB results; compaction/generate model inputs contain no `bbt_*` or foreign tools.

Keep each case's evidence in the plan's 0a/0b results style. Run `pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode` and `git diff --check` before committing. Use the SHark skill (`sharkctl notify`) for long-run completion pings.
