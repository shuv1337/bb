# Handoff: bb tools for OpenCode v2

Written 2026-09-24 PDT. Read `PLAN-opencode-v2-bb-tools.md` first, including "Milestones 1–4 results". Milestones 0–4 are implemented on the branches below. They are not merged, published, or rolled out.

## State

| Item | Where | State |
| --- | --- | --- |
| Plan | bb `/home/shuv/repos/bb` branch `opencode-bb-tools` | Implementation HEAD `d03446fd7982f9c2cbf2073c928d4fa2595c301c`; closeout docs are the commit after that. Not pushed |
| Companion | `~/repos/opencode-bb-tools` branch `m1`, HEAD `fb0a952b66c5c94125a28ed599d26a97786afed3` | Local git. Includes rich failures. Not published |
| Stock engine | `/tmp/oc-stock/node_modules/@opencode/cli-linux-x64/bin/opencode` | `@opencode/cli@2.0.15`. Reinstall if `/tmp` was cleared |
| Installed Shuvcode | `~/.npm-global/lib/node_modules/shuvcode/node_modules/shuvcode-linux-x64/bin/shuvcode` | `2.0.15-shuv.2`. No `bb-tools-engine` patches. `richFailures` is false |
| Local engine | `/home/shuv/repos/shuvcode-bbtools/packages/cli/dist/shuvcode-linux-x64/bin/shuvcode` | Branch `bb-tools-engine`, HEAD `1e15c5e1c3eecbea1f3f74035736331082968789`. `shuvcode v0.0.0-bb-tools-engine-202609242104`. `richFailures` is true |
| `tool-activity` | `/home/shuv/repos/shuvcode-activity`, HEAD `5341c3d97ed314796b06f254c72eb677438de0bd` | In-flight Location leases. Merged into `bb-tools-engine` |
| `rich-tool-errors` | `/home/shuv/repos/shuvcode-richerr`, HEAD `a799356cf1f2a9dfe2575ff30c7dcaa114bf33a4` | Rich failure content and lowering. Merged into `bb-tools-engine` |

## Decisions already made (do not reopen)

- The companion is a standalone OpenCode plugin: repository `shuv1337/opencode-bb-tools`, npm package `opencode-bb-tools`, installed with the engine's `plugin add`. bb never ships or installs it. Creating the GitHub repo or publishing to npm needs explicit user approval.
- No bb core changes and no `HOST_DAEMON_PROTOCOL_VERSION` bump. All bb work stays in `plugins/provider-opencode`.
- Nothing is upstreamed. Shuvcode engine changes are fork patches on `bb-tools-engine`.
- Missing companion keeps today's native-only behavior with a warning. An incompatible companion, a duplicate install, or an opted-in host hard-fails.
- Takeover is the persisted capability in the 0600 owners file, plus a 30s lease and a heartbeat at `ownerLeaseMs / 3`.
- `@opencode/client` stays at 2.0.10. Metadata merge is a raw `PATCH`.
- Plan mode is not offered. The plan agent is still selectable by name.
- Rich failures are a live probe (`hello.features.richFailures`), not an engine version string.

## How to run the matrix

From `~/repos/bb/plugins/provider-opencode`. One vitest invocation covers every `companion-*.live.test.ts` file. Each engine loads a private companion copy. Do not export `BB_OPENCODE_LIVE_ENGINE` into the unit turbo command; that command skips the live files.

```sh
COMPANION=$HOME/repos/opencode-bb-tools
PLUGIN=$HOME/repos/bb/plugins/provider-opencode
STOCK=/tmp/oc-stock/node_modules/@opencode/cli-linux-x64/bin/opencode
INSTALLED=$HOME/.npm-global/lib/node_modules/shuvcode/node_modules/shuvcode-linux-x64/bin/shuvcode
LOCAL=/home/shuv/repos/shuvcode-bbtools/packages/cli/dist/shuvcode-linux-x64/bin/shuvcode

cd "$PLUGIN"
BB_OPENCODE_LIVE_COMPANION=$COMPANION \
BB_OPENCODE_LIVE_ENGINE=$LOCAL \
  pnpm exec vitest run --config vitest.config.ts src/bridge/companion-*.live.test.ts \
  > /tmp/shuvcode/final-matrix-live-local-run1.log 2>&1

BB_OPENCODE_LIVE_COMPANION=$COMPANION \
BB_OPENCODE_LIVE_ENGINE=$INSTALLED \
  pnpm exec vitest run --config vitest.config.ts src/bridge/companion-*.live.test.ts \
  > /tmp/shuvcode/final-matrix-live-installed-run1.log 2>&1

BB_OPENCODE_LIVE_COMPANION=$COMPANION \
BB_OPENCODE_LIVE_ENGINE=$STOCK BB_OPENCODE_LIVE_APP=opencode \
  pnpm exec vitest run --config vitest.config.ts src/bridge/companion-*.live.test.ts \
  > /tmp/shuvcode/final-matrix-live-stock-run1.log 2>&1
```

Run each engine twice, back to back. Then run all three at once. Closeout result: 46 passed in every cell. Logs are `/tmp/shuvcode/final-matrix-live-<engine>-<run1|run2|concurrent>.log`.

Companion, from `~/repos/opencode-bb-tools`:

```sh
npx tsc -p .
node --experimental-strip-types --test test/unit/*.test.ts
BB_OPENCODE_LIVE_ENGINE=$LOCAL BB_OPENCODE_LIVE_APP=shuvcode \
  node --experimental-strip-types --test test/engine/*.test.ts
```

Repeat the engine suite with `$INSTALLED` and with `$STOCK` plus `BB_OPENCODE_LIVE_APP=opencode`. Closeout: typecheck clean, unit 24 passed, engine suite 6 passed on each binary.

bb unit, from `~/repos/bb`, without `BB_OPENCODE_LIVE_ENGINE`:

```sh
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-opencode
git diff --check
```

Closeout: 331 passed, 46 live tests skipped. `git diff --check` was clean in both repos before the closeout docs commit.

`BB_OPENCODE_LIVE_KEEP=1` copies the engine root to `/tmp/shuvcode/kept-roots/` and then removes the original. Live diagnostics are stderr `LIVE` lines. The bridge harness captures stdout as JSON-RPC; never write diagnostics to stdout.

Do not touch the user's running `shuvcode serve --service`. Always use isolated roots. Do not point two live engines at one plugin checkout.

## Gotchas

- Shipped engines are Bun-compiled and provide no plugin modules. The companion resolves `@opencode/*` and `effect` from its own `node_modules`. Keep `effect` pinned to the engine's exact version.
- `hello.features.richFailures` is `context.features.richFailures === true`. The local `bb-tools-engine` binary is true. Stock 2.0.15 and installed 2.0.15-shuv.2 are false. Failure image tests must advertise model input `["text", "image"]` or the engine substitutes "Cannot read image" instead of delivering media.
- A content change in a shared plugin checkout restarts every engine watching it. The harness copies the companion per engine, symlinks `node_modules`, and excludes `.git`.
- Plugin state and RPC registrations are per Location. `session.move` drops the binding. Environment migration interrupts the active turn first, then moves and reattaches.
- `GET /api/session/:id` returns `{data}`. `waitForSessionIdle` unwraps `data`.
- The first model request per session is a title request with no `tools`. Start engines with `--port 0`.
- `pending` uses `waitMs: 0`. A long poll inside the drain holds cancellation past the teardown budget.
- Oversized results are `JSON.stringify(contentItems)` over `hello.limits.maxResultBytes` (1048576). The companion fails the tool; the bridge must not retry.

## Next

Do not publish, push, or open a PR unless the user asks and confirms the exact target.

1. User publishes `opencode-bb-tools` (or creates the GitHub repo first).
2. User runs the Shuvcode release workflow so a released binary contains `bb-tools-engine`.
3. Review and merge `opencode-bb-tools` to bb main.
4. Milestone 5 is per-host rollout. It is not authorized.

Still open, and not release blockers by themselves: live TTL proof only via injected core tests; Anthropic/Bedrock rich-error live acceptance unverified; remote image bytes unbounded on both paths; MCP `isError` content out of scope; durable-log pages still buffered before the 4096 cap; late turn-boundary interleaving and grandchild origin inheritance unit-only.
