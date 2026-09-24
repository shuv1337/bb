---
name: opencode-tools
description: "Install, check, and read status for the opencode-bb-tools companion that runs bb tools inside OpenCode or Shuvcode."
---

# OpenCode bb tools companion

Native bb tools need a separate OpenCode plugin, `opencode-bb-tools`. bb does
not ship or install it. Repository:
https://github.com/shuv1337/opencode-bb-tools

Use the CLI that matches the engine app id. A stock `opencode` CLI does not
write Shuvcode config.

```bash
opencode plugin add opencode-bb-tools
shuvcode plugin add opencode-bb-tools
opencode plugin check opencode-bb-tools
opencode plugin update opencode-bb-tools
opencode plugin remove opencode-bb-tools
```

Pin a version with `opencode-bb-tools@X.Y.Z`. Replace `opencode` with `shuvcode`
on a Shuvcode host.

Supported companion protocol is `bb.tools.v1` versions 1 through 1. A companion
outside that range fails the turn. It does not drop tools quietly. More than
one registration fails attachment and names the specs to remove. A restarted
bridge takes over with the capability saved in the owners file. A second bridge
without that proof cannot attach while the owner lease is live.

`OPENCODE_SERVER_URL` mode uses `hello` and the engine plugin list. Do not look
for companion files on disk. Confirm pickup with status, not by assuming a
reload.

```bash
bb opencode tools status --machine <id>
bb opencode tools status --machine <id> --json
```

SDK: `callRpc("companionStatus", { machineId })`. The provider settings page
shows the same status.

`bb plugin config provider-opencode set bbToolsRequired true` is a global
plugin setting, not per-machine. Absent companion and required fails the turn
with the setup error. Default is false: the thread stays native-only and
warns, with the repository link and the install command. An incompatible
companion fails the turn either way. Status `absent` is only an unavailable
companion RPC and is the only state shown as not installed. `unreachable` is
transport, auth, or an engine that is not ready. `incompatible` is a hello
that does not match or a protocol range that does not overlap. URL mode does
not let `OPENCODE_APP` pick the install command. A `-shuv` service version is
Shuvcode; otherwise status shows both plugin-add commands and which config
each writes.

Released engines interrupt a tool call after 60 minutes without a durable
session event. There is no knob until the host has the in-flight Location
patch. A plugin that sorts before the companion, or removing the companion,
drops in-flight calls as uncertain and does not run them again. Plugins that
sort after the companion restart when it is installed or removed. The next
turn reattaches.

Rollback: detach bb work, `plugin remove` or pin an older companion, then pin
the provider to a commit if needed. Do not delete engine sessions.

A verified native child uses the owning bb thread. A background subagent after
that turn is rejected. A native fork is native-only. `update_environment_directory`
changes the owning bb thread; the next turn moves the native session. Shell
`cd` does not.
