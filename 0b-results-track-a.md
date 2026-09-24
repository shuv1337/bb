# 0b track A results (2026-09-24 PDT)

Bridge-side cancellation, resync, and attach takeover. Live suite: `plugins/provider-opencode/src/bridge/companion-lifecycle.live.test.ts`. Passed on Shuvcode 2.0.15-shuv.1 and stock `@opencode/cli@2.0.15`. Behavior did not differ between engines.

bb interrupts and releases through `thread/stop`. There is no `turn/interrupt` bridge method. The next bb turn after either intent is `thread/resume`. The retained-session path is a native interrupt from another engine client.

- **bb interrupt during a claimed call:** `thread/stop` `{intent:"interrupt", activeTurnId}` (the open `turn.open` `providerTurnId`) while reverse `item/tool/call` `oc-tool-1` is unanswered. The bridge does not wait for bb's reply. It sends `notifications/cancelled` with `{ requestId: "oc-tool-1" }` (`providerToolCallCancellationSchema`) and delivers a failed companion result before `session.interrupt()`. The model sees `bb tool outcome unknown: claimed call was cancelled before a result arrived`. A late success body `LATE_REPLY_MUST_NOT_REACH_MODEL` never appears in a later model request. Stop detaches: a following `turn/start` fails `No active OpenCode session`. `thread/resume` reattaches (new capability, `bb_echo` still advertised) and a new call round-trips (`echo: again`).
- **Native interrupt (retained session):** `POST /api/session/:id/interrupt` from another client returns `{interrupted:true}` and aborts the companion executor. The companion emits control `{type:"cancelled", sessionID, key, state, reason:"interrupted"}`. The bridge reads `pending` and sends `notifications/cancelled` for the reverse id, then ignores a late reply (`echo: native` is not a success). Native evidence on both engines: `session.tool.failed` with `error: {type:"aborted", message:"Tool execution interrupted"}` and `executed:false`. The binding is retained: the same capability still works, and the next `turn/start` round-trips a new bb call with no `thread/resume`.
- **bb release during a claimed call:** `thread/stop` `{intent:"release", activeTurnId:null}` also settles the claimed call locally, sends `notifications/cancelled`, and detaches. The model sees the same uncertain-outcome text. `turn/start` before resume fails `No active OpenCode session`. `thread/resume` reattaches and a new call round-trips (`echo: resumed`). A late reply does not reach the model. Both intents detach; release does not call `session.interrupt()`.
- **No turn boundary during a claimed call:** `injectResync` enqueues the same `{kind:"resync", reason:"reconnect"}` event the pump emits on overflow and reconnect. `reconcileAfterResync` is deferred while a companion call is in flight (`skipping OpenCode resync reconcile … bb tool call still open`). On the session timeline, no `turn.boundary` `completed` appears before `session.tool.success` for that call. The claimed call still delivers `echo: resync` and the model continues with it. The deferred boundary is released when the native turn ends, or forced if a bounded companion read fails so the turn cannot stay open forever.
- **Callbacks stay cancellable:** while a call is claimed and unanswered, a second session on the same bridge reaches the model (`finish without waiting` in that session's request). `thread/stop` intent interrupt on the blocked session returned in 17ms (Shuvcode) and 19ms (stock), under 8s, and did not answer the open call.
- **Attach takeover:** bridge #2 `startLiveBridge` on the same engine and data dir, then `thread/resume` of the same native session while bridge #1 is still connected. The companion epoch/capability fence settles the old claimed call as `bb tool outcome unknown: owner replaced while the call was claimed` (not success, not `owner replaced`). That call is not re-dispatched to bridge #2 (`callId` differs; bridge #2 sees only the new call). `pending`, `claim`, and `result` with the old capability fail `unbound`. A late reply on bridge #1 does not reach the model. Bridge #2 round-trips `echo: new-owner`. A second case tears bridge #1 down before bridge #2 resumes: the native call settles `bb tool outcome unknown`, and the old `callId` never appears in bridge #2's reverse requests.
- **Polling is authoritative:** with control events ignored, a 500ms `pending` poll still claims and forwards the call, and a native interrupt still produces `notifications/cancelled` from the companion's `settled: [{outcome:"cancelled"}]` notice. Notices are dropped once that `pending` response is built.

## Findings / deviations from plan

- bb's stop wire method is `thread/stop`. `intent` is `interrupt` when the daemon has an active turn id, otherwise `release`. This bridge detaches on both. The plan's retained binding is the native interrupt, not a bb stop.
- A native interrupt's model-visible tool text is the engine's `Tool execution interrupted` (`session.tool.failed`, `type:"aborted"`, `executed:false`), not the bridge's uncertain-outcome string. The executor is already interrupted, so a companion `result` cannot become that row. The bridge still cancels the reverse call and ignores a late reply.
- Resync guard skips the whole `reconcileAfterResync` (turn boundary and open-item closes), not only the turn boundary. A natural 1024-event overflow was not forced: the pump keeps up with the subscriber buffer. The live test injects the pump's resync event, which is the path both overflow and reconnect use.
- Attach takeover does not wait for heartbeat expiry. A second `attach` for an already-bound session always replaces the owner. Heartbeat expiry remains a milestone-1 shortcut.
- `thread/stop` does not wait for `session.tool.failed` before returning. Companion `result` and `detach` on teardown are bounded at 2s and stop continues if they hang. With no open companion call, stop does no extra companion wait. The pre-existing interrupt settlement timeout (5s) still applies only when `intent` is `interrupt` and the session has interruptible work.
- Owned-turn boundaries (`translated` completion/interruption, stream failure, `retireSession`, stop's fallback `settleTurn`) settle pending/claimed companion calls locally before the boundary is emitted. Resync still defers that boundary instead of closing the turn.

## Spike shortcuts left

- No owner heartbeat, so attach takeover cannot wait out a live owner (deferred; needs heartbeats, milestone 1). Fencing is the new capability plus a numeric epoch on the binding (`attach` returns `epoch`; the bridge does not coerce a string or fall back to `bindingID`).
- `result` on an already-settled deferred is ignored (`Deferred.doneUnsafe` returns false) instead of identical-payload idempotency.
- A failed companion `result` delivery is retried against the same binding (3 attempts). The record is removed only after acknowledgement or terminal revocation. Binding loss settles the call uncertain, warns `not retrying into a new companion generation`, and revokes only that binding. A boundary in progress on an older binding does not detach a newer one.
- Unclaimed bridge cancel text `bb tool call cancelled`, unclaimed takeover text `bb tool call failed: owner replaced`, and revoke text `bb tool outcome unknown: the binding was revoked while the call was claimed` are implemented. The live cases above are the claimed paths.
- `injectResync` / `bbToolCapability` / `setIgnoreBbToolControl` are test seams on the bridge return, not protocol methods.
- A `pending` response acknowledges settled notices when it is built. If that response is lost on the wire, the notice is not replayed. The next poll still sees a missing key; cancellation of an outstanding reverse call depends on the notice or on `unbound`.

## Settlement texts

| Outcome | Text |
| --- | --- |
| Bridge cancel, never dispatched | `bb tool call cancelled` |
| Bridge cancel, claimed (interrupt or release) | `bb tool outcome unknown: claimed call was cancelled before a result arrived` |
| Takeover, unclaimed | `bb tool call failed: owner replaced` |
| Takeover, claimed | `bb tool outcome unknown: owner replaced while the call was claimed` |
| Explicit detach, claimed, if the bridge did not deliver first | `bb tool outcome unknown: the binding was revoked while the call was claimed` |
| Native interrupt, model-visible | `Tool execution interrupted` |
