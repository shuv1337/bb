# 0b results — track B (ownership, catalogs, children, results)

Passed on Shuvcode 2.0.15-shuv.1 and stock `@opencode/cli@2.0.15`. Live file: `plugins/provider-opencode/src/bridge/companion-ownership.live.test.ts`. Companion: `src/server.ts` on `spike-0b-track-b`.

- **Two same-directory catalogs:** two roots in one workspace, both advertising canonical `bb_lookup`. Root A’s model request schema is `{ properties: { id: string }, required: ["id"] }`; root B’s is `{ properties: { query: string, limit: number }, required: ["query", "limit"] }`. Neither request lists `bbt_*`. Reverse `item/tool/call` for A is `{ threadId: "thread-catalog-a", tool: "bb_lookup", arguments: { id: "alpha" } }` on A’s `providerThreadId`; B is `{ threadId: "thread-catalog-b", arguments: { query: "beta", limit: 2 } }` on B’s id. Same on both engines.
- **Unrelated session denial:** a session created with `POST /api/session` in the same directory advertises only native tools (`edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, `execute`). A scripted `bb_echo` fails with `No tool named "bb_echo" is currently available`. A scripted `bbt_b1_0` fails with `Tool is not available for this request: bbt_b1_0` (session.context already removed it from that request’s definitions, so the engine never enters the companion executor). No reverse `item/tool/call`. Same on both engines.
- **Imported `parentID`:** `POST /api/experimental/session/import` with `parentID` set to the bound root persists that parent (`GET` info `parentID` equals the root). Its model request has the same native-only tool list. A scripted `bb_echo` does not reach bb. Same on both engines.
- **Native child via `subagent`:** mechanism is a companion wrap of the built-in `subagent` tool’s `execute` (`editor.update("subagent")` in the companion transform, which runs after the internal subagent plugin). The wrapper replaces `context.progress`. `subagent.ts` calls `progress({ sessionID: child.id, status: "running" })` before `sessions.prompt`, so the child id is recorded in that progress call, before the original progress effect returns and before the child is prompted. The record is kept only when the call’s first `execute.before` name is `subagent` with count 1 (direct origin) and the parent session is already authorized. The child’s model request lists canonical `bb_echo` and no `bbt_*`. The reverse call (both engines) is exactly:

  ```json
  {
    "providerThreadId": "<root native session>",
    "threadId": "<bb thread id>",
    "turnId": "exec:<root>:4",
    "callId": "call_live_2",
    "tool": "bb_echo",
    "arguments": { "text": "child-hello" },
    "providerNativeIds": true,
    "nativeSessionID": "<child session>",
    "nativeMessageID": "<child assistant message>"
  }
  ```

  `providerThreadId` is the root, not the child. `nativeSessionID` matches `session.tool.progress` `metadata.sessionID`. `nativeSessionID` / `nativeMessageID` are passthrough fields; the host decoder ignores them. Control wakeup uses the binding root `sessionID`, not the child, so the bridge pump (routed by `data.sessionID`) drains the root binding. The pending payload still carries the child’s `sessionID` and `messageID`.
- **Background subagent after the owning turn:** a `subagent` call with `background: true` is stamped with the root turn generation at progress time. When a root-session event’s translated deltas include `turn.boundary`, the bridge awaits companion RPC `bb.tools.v1` `turn` `{ capability, state: "closed" }` before `sendDeltas` publishes that boundary, and the companion increments the generation. A later `bb_echo` from the child is rejected before a pending entry exists. The model sees `{"error":{"type":"tool.execution","message":"bb turn ended; bb tools are unavailable to background subagents after their owning turn"}}`. No reverse call. Same text on both engines. The bridge informs the companion rather than the companion watching session idle: `ctx.session.get` still returned `time.idle === undefined` after the root turn had completed, and a plugin `event.subscribe` on `session.status` / `session.execution.*` had not advanced a generation by the time a late call ran. The bb turn boundary is the policy signal, and awaiting the RPC before publishing it orders the rejection ahead of the next prompt.
- **Native fork and bb fork:** `POST /api/session/:id/fork` returns a session whose HTTP info omits `parentID` (DB `parent_id` is null) and copies `metadata.bbThreadId` from the source. Its model request has no `bb_echo` and no `bbt_*`, and the turn completes (`native fork done` is persisted). It is not blocked. Bridge `thread/fork` attaches a fresh catalog (`bb_forked`, not `bb_echo`) and merge-updates metadata to the new bb thread id. Observed `metadata` is `{ "bbThreadId": "thread-fork-bb" }`. The installed `@opencode/client@2.0.10` `session.update` drops `metadata`, so the runtime sends the merge as a raw `PATCH /api/session/:id`. Both 2.0.15 engines accept it.
- **Canonical deny and plan:** `disallowedTools: ["bb_echo"]` becomes a native `{ action: "bb_echo", resource: "*", effect: "deny" }` rule. The model request does not list `bb_echo` or `bbt_*`, and a scripted call does not reach bb. The native `plan` agent, selected with `providerOptions.agent = "plan"`, still advertises `bb_echo`. It also still advertises `edit`: bb full permission’s `{ action: "*", effect: "allow" }` is merged after the plan agent’s deny-edit rule, so discovery does not wholly-disable `edit`. Same tool lists on both engines.
- **Successful image:** bb success `[inputText "caption", inputImage data:image/png]` becomes, on the next model request, a tool message whose content is the string `caption` (no image), then a trailing user message `[{ "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }]`. Assistant content is `null`. Identical on both engines. This is OpenAI Chat lowering: file parts are split out of the tool result. The mock model’s input capabilities included `image` so the engine did not drop the part for lack of modality.
- **>50 KiB:** a 120 KiB (`122880` byte) text success is the entire tool-message content. No `truncated` marker and no `saved to` path. Companion success results set `metadata.truncated: false`, which `toolOutput.truncate` treats as already decided. Same on both engines.
- **Auxiliary hooks:** `POST /api/session/:id/generate` returns `{ data: { text: "done" } }` and is not the title hook (title requests still have an empty tool list and never execute tools). `POST /api/session/:id/compact` also runs. The new model requests (3, including generate and compaction) list only native tools. No `bb_echo` and no `bbt_*` in tool lists or the serialized requests. Same on both engines.

## Findings / deviations from plan

- Child native identity is carried as extra passthrough fields `nativeSessionID` and `nativeMessageID` on `item/tool/call`. The protocol schema is passthrough and the host decoder drops them. No core or protocol-version change. A later milestone should decide whether correlation belongs in an existing field or a real protocol field.
- Owning-turn close is a companion RPC (`turn`, `state: "closed"`) the bridge awaits before publishing the root `turn.boundary`. Plugin `session.get` `time.idle` and plugin event subscription were not a reliable signal on these binaries.
- Plan mode plus bb `permissionMode: "full"` still advertises `edit`. The plan agent’s deny-edit rule loses to the later session allow-`*`. bb tools remain available, which is the required outcome.
- Native fork HTTP info omits `parentID` rather than sending `null`.
- An unauthorized `bbt_*` call fails in the engine as “not available for this request” and never enters the companion executor, because `session.context` already deleted the internal name.

## Spike shortcuts left

- Turn-close notification covers translator deltas for the root session only, not the zero-work timer or stream-failure boundary paths.
- Companion executor does not re-check a live `disallowedTools` list; canonical deny is the native permission rule on `options.permission`.
- Descendant authorization is in-memory for the Location lifetime.
- `metadata` update bypasses `@opencode/client@2.0.10` with a raw PATCH.
