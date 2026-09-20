Start a thread, pick OpenCode, and talk to the OpenCode v2 service already running on the host. bb is a client of that shared service, not a second OpenCode process.

## What you get

- Native OpenCode sessions, checkpoint forks, resume, rename, and compact.
- Plan mode maps to the OpenCode `plan` agent. `defaultAgent` covers new threads. `defaultVariant` selects a catalog variant the picker cannot name.
- Skills from OpenCode's catalog and `.opencode` / `.agents` / `.claude` directories, plus `.opencode/commands`.
- Health and install status on each host. Install runs only when no v2-capable app is present.

## How it works

bb attaches to a live OpenCode v2 registration (`opencode`, `shuvcode`, or another app) or to `BB_OPENCODE_SERVER`. It never calls OpenCode's destructive `Service.ensure`. Deleting a bb thread leaves the OpenCode session in place.

OpenCode (ACP) remains available as `acp-opencode` for v1 binaries.

## Requirements

- A running OpenCode v2 service (`<app> serve --service` or the TUI), or `BB_OPENCODE_SERVER` (optional `BB_OPENCODE_PASSWORD`).
- Optional: `BB_OPENCODE_APP` to pick among live apps (`opencode`, `shuvcode`, …).
- Optional: `bb plugin config provider-opencode set defaultAgent <name>`.
- Optional: `bb plugin config provider-opencode set defaultVariant <id>`.
