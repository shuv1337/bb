# OpenCode v2 provider

First-party plugin for [OpenCode](https://opencode.ai) v2. bb is an HTTP
client of the host's shared OpenCode service via `@opencode/client@2.0.10`
(`/promise` and `/service` only). It does not embed `@opencode/sdk` and it
does not spawn `opencode acp`.

What lives here:

- `server.ts` — `bb.providers.register` for `opencode` (`src/declaration.ts`),
  the `defaultAgent` / `defaultVariant` / `bbToolsRequired` settings, and
  `bb opencode tools status`.
- `src/host.ts` — the `bb.host` artifact: provider bridge
  (`src/bridge/bridge.ts`) and `resolveNativeRoots` (`src/native-roots.ts`).
- `src/bridge/provider-maintenance.ts` — health from read-only discovery and
  an install plan the daemon runs. Auto-start is off. `Service.ensure` is
  never called.

The provider is always visible, so hosts without OpenCode still show its
Install action. React for `app.tsx` stays a devDependency: the host shims
`react` at app build time, so a git install with `--omit=dev` does not need
a second copy in `dependencies`.

## bb tools companion

bb tools run inside OpenCode through a separate OpenCode plugin,
[`opencode-bb-tools`](https://github.com/shuv1337/opencode-bb-tools). This
provider does not ship, install, upgrade, or remove that plugin. OpenCode's
own `plugin add` does. The packages are separate so an OpenCode host can load
the companion without a bb install, and so a bb upgrade cannot write into the
engine's plugin directory.

Install on the engine host, as the user that runs the engine service. Use the
CLI that matches the engine's app id. A stock `opencode` CLI writes stock
config, not Shuvcode's.

```sh
opencode plugin add opencode-bb-tools
shuvcode plugin add opencode-bb-tools
```

Before the npm package is published, pin a Git tag:

```sh
opencode plugin add github:shuv1337/opencode-bb-tools#vX.Y.Z
shuvcode plugin add github:shuv1337/opencode-bb-tools#vX.Y.Z
```

Check, upgrade, and remove with the same CLI:

```sh
opencode plugin check opencode-bb-tools
opencode plugin update opencode-bb-tools
opencode plugin remove opencode-bb-tools
```

Replace `opencode` with `shuvcode` on a Shuvcode host. Config changes are
watched; confirm pickup with status, not by assuming a reload.

This provider supports companion protocol `bb.tools.v1` versions 1 through 1.
`hello` answers even when the ranges do not overlap. A companion outside that
range fails the turn with an install hint. It does not emit the dropped-tools
warning.

Status uses `hello` and the engine plugin list, including when
`OPENCODE_SERVER_URL` points at a remote engine. It does not read companion
files off disk. `state` is `ready`, `absent`, `unreachable`, or
`incompatible`. `absent` is only an unavailable companion RPC and is the only
state shown as not installed, with an install command. `unreachable` is
transport, auth, or an engine that is not ready. `incompatible` is a hello
that does not match or a protocol range that does not overlap.

```sh
bb opencode tools status --machine <id>
bb opencode tools status --machine <id> --json
```

SDK: `callRpc("companionStatus", { machineId })`. The settings page shows the
same status and the repository link. An absent companion also shows the
install command. A service version containing `-shuv` is Shuvcode.
`/api/info` does not report an app id, so URL mode does not let
`OPENCODE_APP` choose the command. When the service identity is uncertain,
status shows both `opencode plugin add` and `shuvcode plugin add` and says
which config each writes.

`bb plugin config provider-opencode set bbToolsRequired true` is a global
plugin setting. It applies to every machine; bb settings are not per-machine.
Default false. Absent companion and required fails the turn with the setup
error. Off keeps native-only threads and a persistent warning that names
`opencode-bb-tools`, links the repository, and gives the install command. An
incompatible companion fails the turn either way.

Released engines idle-evict a Location after 60 minutes with no durable session
event. Tool progress and plugin RPC do not count. A bb tool call longer than
that window is interrupted, and a late result is an uncertain outcome, until
Shuvcode's in-flight Location patch is on that host. There is no env knob.

Editing, adding, or removing any plugin that sorts before the companion
disposes it, drops its bindings, and interrupts an in-flight call. Installing
or removing the companion restarts plugins that sort after it. The in-flight
call settles as uncertain and is not dispatched again. The next turn reattaches.

Rollback, in order: stop affected bb work and detach bindings; `plugin remove`
the companion, or pin an older companion with `plugin add <pkg>@<version>`;
then, if needed, install a provider pinned to a known commit
(`git:https://github.com/shuv1337/bb@<sha>`). Do not delete engine sessions.
An unbound marked session has bb tools stripped. It is not blocked.

A native child created by a verified `subagent` call uses the owning bb
thread's catalog and current denies. A background subagent that outlives the
owning turn is rejected and does not run the bb tool. A native fork is not a
child: it runs native-only. `update_environment_directory` changes the owning
bb thread's directory; the next turn moves the native session to that
Location and reattaches there. Shell `cd` does not.

## Install from GitHub

Requires bb 0.43.4 or newer with Plugin SDK 0.5.9 or newer (0.5.x).

```sh
bb plugin install 'git:https://github.com/shuv1337/bb@main' --subdirectory plugins/provider-opencode --yes
bb plugin enable provider-opencode
```

The installer builds the server and host artifacts from source. No separate
release branch or monorepo dependency installation is needed. Start an OpenCode
v2 or Shuvcode service on each machine you want to use; this plugin does not
start one automatically. OpenCode v1 is not supported.

Update an existing Git installation with `bb plugin update provider-opencode --yes`.
An existing bundled installation already contains this plugin; do not install a
second copy over it.

On our bb fork, disable the legacy ACP provider with
`bb plugin config provider-acp set enableOpenCode false`. That setting is specific
to our fork; stock bb users should select the native `opencode` provider instead
of `acp-opencode`. Disabling the entire ACP plugin also disables its other agents.

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
