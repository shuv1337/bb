# OpenCode provider

First-party plugin for [OpenCode](https://opencode.ai) v2. bb is an HTTP
client of the host's shared OpenCode service via `@opencode/client@2.0.10`
(`/promise` and `/service` only). It does not embed `@opencode/sdk` and it
does not spawn `opencode acp`.

What lives here:

- `server.ts` — `bb.providers.register` for `opencode` (`src/declaration.ts`)
  and the `defaultAgent` / `defaultVariant` settings.
- `src/host.ts` — the `bb.host` artifact: provider bridge
  (`src/bridge/bridge.ts`) and `resolveNativeRoots` (`src/native-roots.ts`).
- `src/bridge/provider-maintenance.ts` — health from read-only discovery and
  an install plan the daemon runs. Auto-start is off. `Service.ensure` is
  never called.

The provider is always visible, so hosts without OpenCode still show its
Install action.

## Skills and commands

Declared roots (`experimental_nativeSkillRoots` / `experimental_nativeCommandRoots`):

- `user` skills: `.claude/skills` (skip Claude plugin manifests) and
  `.agents/skills`, recursive.
- `project` skills: `.opencode/skills`, `.claude/skills`, `.agents/skills`,
  recursive with ancestors.
- `project` commands: `.opencode/commands` and `.opencode/command` with
  ancestors, plural first. Upstream OpenCode reads both spellings. These
  roots are always scanned, whether or not the service is up.

Host `resolveNativeRoots` prefers the live catalog and falls back to the
filesystem when that request did not succeed:

- Skills: `GET /api/skill` at the workspace. `~/.config/<app>/skills` (and
  upstream `OPENCODE_CONFIG_DIR/skills`) is always included, because that
  directory depends on the attached app. Catalog entries are added when
  `path` is an accessible host `SKILL.md` file or skill directory outside
  those directories and the declared home and workspace roots. Virtual
  `/builtin/…` paths and URLs are skipped. Nested catalog ids become skill-file fallback names.
- Commands: `GET /api/command` at the workspace. The payload is
  `{ name, description? }` with no path, so each safe name is written as
  markdown under `<plugin dataDir>/opencode-command-catalog/<app>/<cwd hash>`
  and that directory is the commands root. Every path segment below the
  data directory must be a plain directory, not a symlink, and the result
  must `realpath` to itself. An unchanged catalog is not rewritten. The
  host worker removes the directories it wrote when it is disposed, and
  on first use removes catalogs left by a worker that crashed. Nested
  names keep `/` as directories. bb's scanner joins those directories with
  `:`; `session.command` sends `/` again.
- Command fallback, when `GET /api/command` was not fetched or the catalog
  could not be written: `~/.config/<app>/commands` and `command`, plus
  upstream `OPENCODE_CONFIG_DIR` copies of both. A write failure never
  drops skills.

Discovery `health.appId` selects `<app>` (`opencode`, `shuvcode`, …), using
`XDG_CONFIG_HOME` when set. `OPENCODE_APP` is the fallback when discovery
has none. `OPENCODE_CONFIG_DIR` is honored only for upstream `opencode`.

bb cannot register extra skill roots on the session (`skills/configure` is
off). Only skills already in OpenCode's catalog can be activated.

## Environment

`OPENCODE_SERVER_URL`, `OPENCODE_SERVER_PASSWORD`, and `OPENCODE_APP` are
read from the host daemon's environment. They are declared passthrough so
they reach the bridge, and they have no `BB_` prefix so they also survive the
host worker's `BB_*` strip, which is where `resolveNativeRoots` runs.
Username for explicit URL auth is always `opencode`. A 401 is
`unauthenticated`.

Without `OPENCODE_SERVER_URL`, discovery reads `service*.json` under
`$XDG_STATE_HOME/{opencode,shuvcode,opencode-next/opencode,<OPENCODE_APP>}`
and never starts a service. A registration's password is sent only when its
URL is on this host: loopback, `0.0.0.0`/`[::]`, or an IP literal equal to
one of this host's interface addresses. Host names other than `localhost`
are not resolved. Any other registration is `remote`: it is skipped and
never probed. Health reports `unknown`, with a message pointing to
`OPENCODE_SERVER_URL`, only when no local registration is live or rejects
authentication. Use `OPENCODE_SERVER_URL` and `OPENCODE_SERVER_PASSWORD` to
attach to a service on another host.

PATH `opencode` may be a symlink; app identity comes from `--version`
(`shuvcode v2.0.8` → `shuvcode`). The installer runs only when no
v2-capable binary and no registration exist. A discovered app (PATH branding
or registration) is the install target; `OPENCODE_APP` cannot replace a
present binary. Default when nothing is present and `OPENCODE_APP` is unset
is `npm install -g shuvcode` (`OPENCODE_INSTALL_DEFAULT_APP_ID`), on every
platform, Windows included. `OPENCODE_APP=opencode` selects upstream
OpenCode v2 via `https://opencode.ai/v2/install` (`@opencode/cli`). Upstream
OpenCode has no Windows install plan; download the Windows CLI from the v2
docs. bb never replaces an installed `opencode` with `shuvcode`, or a fork
with upstream. A host whose only PATH binary is OpenCode v1 keeps the upstream
v2 installer (or the Windows download message) unless `OPENCODE_APP` asks for
`shuvcode`. A PATH binary whose `--version` probe fails counts as not
installed, so Install adds `shuvcode` next to it. The install default does not change discovery, native roots
or the command-catalog app id, which still default to `opencode`. Install status
reports `npmGlobal` only when npm lists the package globally and the binary
on PATH resolves into that package; it does not query the npm registry for
a latest version.

## Agents and variants

`bb plugin config provider-opencode set defaultAgent reviewer` sets the
plugin default. Plan composer action sends `{ agent: "plan" }`. Leaving plan
sends `null` or that setting; the bridge resolves OpenCode's `default_agent`.

`bb plugin config provider-opencode set defaultVariant thinking` sets
`providerOptions.variant`. Empty means the model's native default (`null`).
The bb picker only lists closed reasoning levels (`none`…`max`). Catalog ids
outside that ladder (`thinking`, `minimal`) are selected through this
setting. Bridge contract: a picker reasoning level is sent as the OpenCode
variant only when it is not `none` and the model's `variants[]` lists it.
Otherwise `defaultVariant` (`providerOptions.variant`) applies, and it must
be in that model's `variants[]` or thread start fails with an unknown-variant
error. OpenCode variant `none` is reachable only through `defaultVariant`.

## Tests

`src/bridge/bridge.conformance.test.ts` runs the shared bridge conformance
suite against `createFakeOpenCodeRuntime`. `bridge.recorded-conformance.test.ts`
replays the sanitized event fixtures in `src/fixtures/` through the fake
runtime for the `turn-tools`, `user-question`, `steer`, `stop-interrupt`,
`fork`, `resume`, and `compaction` cells. There is no HTTP/SSE replay lane:
the parity recordings under `packages/provider-bridge-protocol/recordings`
assume a provider child on stdio. Raw record-mode output under
`plugins/*/recordings/` is gitignored; commit only sanitized fixtures.
