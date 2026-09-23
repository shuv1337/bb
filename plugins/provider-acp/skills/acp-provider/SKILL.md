---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, and compaction in BB."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, and `hermes` appear as `acp-opencode` (OpenCode
(ACP)), `acp-omp`, `acp-grok`, and `acp-hermes-agent`. Native OpenCode v2 is
provider `opencode` from `provider-opencode`, not this plugin. Inspect the
target host's catalog with `bb provider list` and
`bb provider models <provider-id>` using its environment or machine selector.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. BB lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; BB discovers them there. OpenCode agents are session modes, not
models selectable through BB's model field.

OpenCode ACP supports the core `bb thread compact` command; Cursor ACP does not
expose compatible compaction. Check the actual agent's capabilities before
attempting provider-specific recovery.
