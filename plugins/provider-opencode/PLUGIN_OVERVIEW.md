Start a thread, pick OpenCode, and talk to the OpenCode v2 service already running on the host. bb is a client of that shared service, not a second OpenCode process.

## What you get

- Native OpenCode sessions, checkpoint forks, resume, rename, and compact.
- Plan mode maps to the OpenCode `plan` agent. `defaultAgent` covers new threads. `defaultVariant` selects a catalog variant the picker cannot name.
- Skills from OpenCode's catalog and `.opencode` / `.agents` / `.claude` directories, plus `.opencode/commands` and `.opencode/command`.
- Health and install status on each host. Install runs only when no v2-capable app is present.

## How it works

bb attaches to a live OpenCode v2 registration (`opencode`, `shuvcode`, or another app) or to `OPENCODE_SERVER_URL`. It never calls OpenCode's destructive `Service.ensure`. Deleting a bb thread leaves the OpenCode session in place.

OpenCode (ACP) remains available as `acp-opencode` for v1 binaries.

## Requirements

- A running OpenCode v2 service (`<app> serve --service` or the TUI), or `OPENCODE_SERVER_URL` (optional `OPENCODE_SERVER_PASSWORD`).
- Optional: `OPENCODE_APP` to pick among live apps (`opencode`, `shuvcode`, …).
- Set these on the host daemon's environment. They have no `BB_` prefix, so the host worker keeps them.
- Optional: `bb plugin config provider-opencode set defaultAgent <name>`.
- Optional: `bb plugin config provider-opencode set defaultVariant <id>`.
