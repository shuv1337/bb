---
name: opencode-provider
description: "Inspect BB OpenCode provider defaultAgent, defaultVariant, OPENCODE_SERVER_URL, OPENCODE_APP, OPENCODE_SERVER_PASSWORD, native skills and commands, and compaction."
---

# OpenCode provider

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
overrides this setting. Variant `none` is sent only when that model lists it.

These ride `providerOptions` as `{ agent, variant }`.

## Environment

Set on the host daemon's environment. No `BB_` prefix, so the host worker
that resolves skills and commands keeps them:

- `OPENCODE_SERVER_URL` — attach to this v2 URL; no registration scan.
- `OPENCODE_SERVER_PASSWORD` — basic auth password; username is `opencode`.
  Wrong password → `unauthenticated`.
- `OPENCODE_APP` — prefer this app id (`opencode`, `shuvcode`, …) among
  live registrations and as the install target when nothing is installed.

PATH `opencode` may be a symlink; identity is `--version` output.

## Skills, commands, compact, rewind

`bb skill list` shows OpenCode nested skills from `GET /api/skill` when the
service is up, and from filesystem roots when it is down. The `/` menu
prefers `GET /api/command` the same way; when the service is down it reads
`.opencode/commands` and `.opencode/command` in the workspace and
`~/.config/<app>/commands` and `command`. A picked command runs
`session.command`, not a pasted prompt. OpenCode (ACP) does not call these
catalogs. Compact is `bb thread compact` (OpenCode compact RPC, not
`/compact`). Fork is checkpoint rewind. Deleting a bb thread does not remove
the OpenCode session.
