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

## Skills and commands

Declared roots (`experimental_nativeSkillRoots` / `experimental_nativeCommandRoots`):

- `user` skills: `.claude/skills` (skip Claude plugin manifests) and
  `.agents/skills`, recursive.
- `project` skills: `.opencode/skills`, `.claude/skills`, `.agents/skills`,
  recursive with ancestors.
- `project` commands: `.opencode/commands` with ancestors. This root is
  always scanned, whether or not the service is up.

Host `resolveNativeRoots` prefers the live catalog and falls back to the
filesystem when that request did not succeed:

- Skills: `GET /api/skill` at the workspace. `~/.config/<app>/skills` (and
  upstream `OPENCODE_CONFIG_DIR/skills`) is always included, because that
  directory depends on the attached app. Catalog entries are added when
  `path` is an accessible host file outside those directories and the
  declared home and workspace roots. Virtual `/builtin/…` paths and URLs
  are skipped. Nested catalog ids become skill-file fallback names.
- Commands: `GET /api/command` at the workspace. The payload is
  `{ name, description? }` with no path, so each safe name is written as
  markdown under a temporary catalog directory and that directory is the
  commands root. Nested names keep `/` as directories. bb's scanner joins
  those directories with `:`; `session.command` sends `/` again.
- Command fallback, only when `GET /api/command` was not fetched:
  `~/.config/<app>/commands`, legacy `command`, upstream
  `OPENCODE_CONFIG_DIR` copies of both, and `.opencode/command` on
  workspace ancestors.

Discovery `health.appId` selects `<app>` (`opencode`, `shuvcode`, …), using
`XDG_CONFIG_HOME` when set. `BB_OPENCODE_APP` is the fallback when discovery
has none. `OPENCODE_CONFIG_DIR` is honored only for upstream `opencode`.

bb cannot register extra skill roots on the session (`skills/configure` is
off). Only skills already in OpenCode's catalog can be activated.

## Environment

`BB_OPENCODE_SERVER`, `BB_OPENCODE_PASSWORD`, and `BB_OPENCODE_APP` are
passthrough so a value set on the host daemon reaches the bridge. Username
for explicit URL auth is always `opencode`. A 401 is `unauthenticated`.

PATH `opencode` may be a symlink; app identity comes from `--version`
(`shuvcode v2.0.8-shuv.1` → `shuvcode`). The installer runs only when no
v2-capable binary and no registration exist. A discovered app (PATH branding
or registration) is the install target; `BB_OPENCODE_APP` cannot replace a
present binary. Default when nothing is present is upstream OpenCode via
`https://opencode.ai/v2/install` (`@opencode/cli`). `BB_OPENCODE_APP=shuvcode`
selects `npm install -g shuvcode`. Windows has no package-manager install;
download the CLI from the v2 docs. bb never replaces a fork with upstream.

## Agents and variants

`bb plugin config provider-opencode set defaultAgent reviewer` sets the
plugin default. Plan composer action sends `{ agent: "plan" }`. Leaving plan
sends `null` or that setting; the bridge resolves OpenCode's `default_agent`.

`bb plugin config provider-opencode set defaultVariant thinking` sets
`providerOptions.variant`. Empty means the model's native default (`null`).
The bb picker only lists closed reasoning levels (`none`…`max`). Catalog ids
outside that ladder (`thinking`, `minimal`) are selected through this
setting. Bridge contract: an explicit user reasoning level overrides
`providerOptions.variant`; send OpenCode variant `none` only when that id is
in the model's `variants[]`; validate any variant against `model.list`.
