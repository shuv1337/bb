---
name: opencode-provider
description: "Inspect BB OpenCode provider defaultAgent, defaultVariant, BB_OPENCODE_SERVER, BB_OPENCODE_APP, BB_OPENCODE_PASSWORD, native skills, and compaction."
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

Passthrough on the host daemon:

- `BB_OPENCODE_SERVER` — attach to this v2 URL; no registration scan.
- `BB_OPENCODE_PASSWORD` — basic auth password; username is `opencode`. Wrong
  password → `unauthenticated`.
- `BB_OPENCODE_APP` — prefer this app id (`opencode`, `shuvcode`, …) among
  live registrations and as the install target when nothing is installed.

PATH `opencode` may be a symlink; identity is `--version` output.

## Skills, compact, rewind

`bb skill list` shows OpenCode nested skills from the catalog and filesystem
roots. Compact is `bb thread compact` (OpenCode compact RPC, not `/compact`).
Fork is checkpoint rewind. Deleting a bb thread does not remove the OpenCode
session.
