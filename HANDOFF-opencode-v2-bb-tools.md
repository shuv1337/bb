# Handoff: bb tools for OpenCode v2

Written 2026-09-24 PDT. Read `PLAN-opencode-v2-bb-tools.md` first; it is the design of record. Milestone 0b passed. Next is milestone 1.

## State

| Item | Where | State |
| --- | --- | --- |
| Plan | bb branch `spike/opencode-bb-tools-0b`, HEAD `9331f42df67bf64648d75ac031e91f829948263d` | 0b results and design changes recorded; not pushed |
| Companion spike | `~/repos/opencode-bb-tools` branch `spike-0b`, HEAD `3926d0dce6a472a2f8163c0063c85cc31459c427` | Local git repo, no remote |
| Stock engine | `/tmp/oc-stock` (`npm i @opencode/cli@2.0.15`) | Temporary; reinstall if `/tmp` was cleared |
| Shuvcode binary | `~/.npm-global/lib/node_modules/shuvcode/node_modules/shuvcode-linux-x64/bin/shuvcode` | 2.0.15-shuv.1 |

## Decisions already made (do not reopen)

- The companion is a standalone OpenCode plugin: repository `shuv1337/opencode-bb-tools`, npm package `opencode-bb-tools`, installed with the engine's `plugin add`. bb never ships or installs it. Creating the GitHub repo or publishing to npm needs explicit user approval at that step.
- No bb core changes and no `HOST_DAEMON_PROTOCOL_VERSION` bump. All bb work stays in `plugins/provider-opencode`. If a core change seems necessary, stop and raise it.
- Nothing is upstreamed. Shuvcode engine changes (milestone 1b) are fork patches.
- Missing companion keeps today's native-only behavior with a warning; only an incompatible companion or an opted-in host hard-fails.

## How to run

```sh
cd ~/repos/bb/plugins/provider-opencode
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode
# unit: 263 passed, 35 live tests skipped

BB_OPENCODE_LIVE_ENGINE=~/.npm-global/lib/node_modules/shuvcode/node_modules/shuvcode-linux-x64/bin/shuvcode \
  pnpm exec vitest run --config vitest.config.ts \
  src/bridge/companion-engine.live.test.ts \
  src/bridge/companion-lifecycle.live.test.ts \
  src/bridge/companion-ownership.live.test.ts \
  src/bridge/companion-reload.live.test.ts > /tmp/oc-live.log 2>&1

BB_OPENCODE_LIVE_ENGINE=/tmp/oc-stock/node_modules/@opencode/cli-linux-x64/bin/opencode \
  BB_OPENCODE_LIVE_APP=opencode \
  pnpm exec vitest run --config vitest.config.ts \
  src/bridge/companion-engine.live.test.ts \
  src/bridge/companion-lifecycle.live.test.ts \
  src/bridge/companion-ownership.live.test.ts \
  src/bridge/companion-reload.live.test.ts > /tmp/oc-live-stock.log 2>&1
```

`BB_OPENCODE_LIVE_KEEP=1` copies the engine root to `/tmp/shuvcode/kept-roots/` and then removes the original. Engine logs are under `<root>/data/<appId>/log/` (and under the kept copy). Live diagnostics are stderr `LIVE` lines. The bridge harness captures stdout as JSON-RPC; never write diagnostics to stdout. Companion typecheck: `cd ~/repos/opencode-bb-tools && npx tsc -p .`.

Do not touch the user's running `shuvcode serve --service`. Always use isolated roots. Do not point two live engines at one plugin checkout.

## Gotchas

- Shipped engines are Bun-compiled and provide no plugin modules; the companion resolves `@opencode/*` and `effect` from its own `node_modules`. Keep `effect` pinned to the engine's exact version.
- A companion-built `Tool.Error` fails the engine's `instanceof` and loses metadata; the `execute.after` re-wrap with `event.error.constructor` is what preserves it.
- Local-directory plugins need a root `server.ts`/`index.ts`; if missing at engine start, adding it later is not picked up. `plugin add` accepts `git+file:///path#<sha>` and installs dependencies without running scripts.
- A content change in a shared plugin checkout restarts every engine watching it. The harness copies the companion (and auxiliary plugin dirs) per engine, symlinks `node_modules`, and excludes `.git`.
- Plugin state and RPC registrations are per Location. `session.move` changes a session's Location and drops the binding; the bridge handle's `location` then goes stale.
- `GET /api/session/:id` returns `{data}`. `waitForSessionIdle` unwraps `data`, requires `outcome` of `succeeded`, `failed`, or `interrupted`, a numeric `time.idle`, and absence from `GET /api/session/active`.
- `GET /api/experimental/session/:id/log` on these binaries returns only `log.synced` on the first page. Recovery pages with `after` and still reads one tail window when that first page is a watermark. Persisted assistant messages have no execution id; an unlinked origin is rejected, not treated as the live turn.
- Shuvcode puts direct (`codemode:false`) tools inside Code Mode's `tools` object; stock 2.0.15 does not.
- The first model request per session is a title request with no `tools`. Start engines with `--port 0` or consecutive stock engines reuse a keep-alive socket and fail with `fetch failed`.
- `execute.before` for a direct call carries the name the model called (canonical); for Code Mode the first event is `execute`, then inner events use internal names with the same call ID.

## Next: milestone 1

Implement the companion contract and lifecycle. Pick up the spike shortcuts in the plan's "Carried into milestone 1" list before treating the contract as done. Milestone 1b (Shuvcode rich failures and in-flight Location activity, including the injected-TTL proof) is the fork patch. Nothing is upstreamed. Publishing the companion still needs explicit approval.
