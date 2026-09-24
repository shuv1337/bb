---
name: opencode-provider
description: "Inspect BB OpenCode v2 provider defaultAgent, defaultVariant, OPENCODE_SERVER_URL, OPENCODE_APP, OPENCODE_SERVER_PASSWORD, native skills and commands, and compaction."
---

# OpenCode v2 provider

Provider id `opencode` is the native v2 client. `acp-opencode` is OpenCode
(ACP) and stays for v1. Use the target host catalog for models.

## Settings

```bash
bb plugin config provider-opencode set defaultAgent reviewer
bb plugin config provider-opencode unset defaultAgent
bb plugin config provider-opencode set defaultVariant thinking
bb plugin config provider-opencode unset defaultVariant
```

`defaultAgent` is the OpenCode agent for new threads. Empty uses OpenCode's
`default_agent` (usually `build`). Plan mode always uses `plan`. Unknown
names fail at thread start.

`defaultVariant` is an OpenCode catalog variant id (`thinking`, `minimal`,
`high`, …). Empty uses the model's native default. A picker reasoning level
replaces it only when that level is not `none` and the model lists it as a
variant. Otherwise `defaultVariant` is sent, and it must be one of the
model's variants or thread start fails. Variant `none` is reachable only
through `defaultVariant`.

These ride `providerOptions` as `{ agent, variant }`.

## Environment

Set on the host daemon's environment. No `BB_` prefix, so the host worker
that resolves skills and commands keeps them:

- `OPENCODE_SERVER_URL` — attach to this v2 URL; no registration scan.
- `OPENCODE_SERVER_PASSWORD` — basic auth password; username is `opencode`.
  Wrong password → `unauthenticated`.
- `OPENCODE_APP` — prefer this app id (`opencode`, `shuvcode`, …) among
  live registrations and as the install target when nothing is installed.
  Unset, Install installs `shuvcode` (`npm install -g shuvcode`);
  `OPENCODE_APP=opencode` installs upstream OpenCode v2. An installed app of
  either kind is used as is and never replaced. A PATH OpenCode v1 is offered
  the upstream v2 installer, not `shuvcode`.

The provider is listed on every host, so the Install action is reachable
where OpenCode is missing.

Without `OPENCODE_SERVER_URL`, bb reads `service*.json` registrations under
`$XDG_STATE_HOME` (default `~/.local/state`) and never starts a service. A
registration is sent its password only when its URL is on this host
(loopback, `0.0.0.0`/`[::]`, or one of this host's interface IPs). One on
another host is skipped and never contacted. Health is `unknown`, pointing
to `OPENCODE_SERVER_URL`, only when no local registration is live or rejects
authentication. Attach to a remote service with `OPENCODE_SERVER_URL` and
`OPENCODE_SERVER_PASSWORD`.

PATH `opencode` may be a symlink; identity is `--version` output.

## Skills, commands, compact, rewind

`bb skill list` shows OpenCode nested skills from `GET /api/skill` when the
service is up, and from filesystem roots when it is down. The `/` menu
prefers `GET /api/command` the same way: bb writes the catalog names as
markdown under the plugin data directory
(`opencode-command-catalog/<app>/<cwd hash>`). When the service is down or
that directory cannot be written, it reads `~/.config/<app>/commands` and
`command` instead. Project `.opencode/commands` and `.opencode/command`,
from the repository root to the current directory, are always scanned. A
picked command runs `session.command`, not a pasted prompt. OpenCode (ACP)
does not call these catalogs. Compact is `bb thread compact` (OpenCode
compact RPC, not `/compact`). Fork is checkpoint rewind. Deleting a bb
thread does not remove the OpenCode session.
