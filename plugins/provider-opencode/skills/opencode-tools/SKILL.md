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

Before npm publication, pin a tag:
`github:shuv1337/opencode-bb-tools#vX.Y.Z`. Replace `opencode` with `shuvcode`
on a Shuvcode host.

Supported companion protocol is `bb.tools.v1` versions 1 through 1. A companion
outside that range fails the turn. It does not drop tools quietly.

`OPENCODE_SERVER_URL` mode uses `hello` and the engine plugin list. Do not look
for companion files on disk. Confirm pickup with status, not by assuming a
reload.

```bash
bb opencode tools status --machine <id>
bb opencode tools status --machine <id> --json
```

SDK: `callRpc("companionStatus", { machineId })`. The provider settings page
shows the same status.

`bb plugin config provider-opencode set bbToolsRequired true` fails the turn
when the companion is absent. Default is false: the thread stays native-only
and warns, with the repository link and the install command. An incompatible
companion fails the turn either way.

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
