# 0b track A results (2026-09-24 PDT)

Bridge-side cancellation, resync, and attach takeover. Live suite: `plugins/provider-opencode/src/bridge/companion-lifecycle.live.test.ts`. Passed on Shuvcode 2.0.15-shuv.1 and stock `@opencode/cli@2.0.15`. Behavior did not differ between engines.

- **bb interrupt during a claimed call:** plugin-local `turn/interrupt` (`{threadId, providerThreadId}`) while reverse `item/tool/call` `oc-tool-1` is unanswered. The bridge does not wait for bb's reply. It sends `notifications/cancelled` with `{ requestId: "oc-tool-1" }` (the protocol shape: `providerToolCallCancellationSchema`, method `notifications/cancelled`) and delivers a failed companion result. The model sees `bb tool outcome unknown: claimed call was cancelled before a result arrived`. A late success body `LATE_REPLY_MUST_NOT_REACH_MODEL` is ignored and never appears in a later model request. The session is retained: the same capability is still bound, the next `turn/start` still advertises `bb_echo`, and a new call round-trips (`echo: again`).
- **Native interrupt:** `POST /api/session/:id/interrupt` from another client returns `{interrupted:true}` and aborts the companion executor. The companion emits control `{type:"cancelled", sessionID, key, state, reason:"interrupted"}`. The bridge reads `pending` and sends `notifications/cancelled` for the reverse id, then ignores a late reply (that text never reaches the model, and `echo: native` is not a success). Native evidence on both engines: `session.tool.failed` with `error: {type:"aborted", message:"Tool execution interrupted"}` and `executed:false`. The next turn in the retained session round-trips a new bb call.
- **bb stop, then reconstructed next turn:** `thread/stop` with `intent:"interrupt"` revokes the binding and detaches. The same reverse id gets `notifications/cancelled`. A following `turn/start` on that thread fails `No active OpenCode session` — stop always detaches, for both `interrupt` and `release`; there is no retained-session stop path. `thread/resume` reattaches from the owners file before the next prompt (no dropped-tools warning; the resumed model request includes `bb_echo`). The old capability fails companion `pending` with `unbound`. A new call round-trips (`echo: resumed`). A late reply to the stopped id does not reach the model.
- **No turn boundary during a claimed call:** `injectResync` enqueues the same `{kind:"resync", reason:"reconnect"}` event the pump emits on overflow and reconnect. `reconcileAfterResync` is skipped while a companion call is in flight (`skipping OpenCode resync reconcile … bb tool call still open`). No `turn.boundary` `completed` is emitted. The claimed call still delivers `echo: resync` and the model continues with it.
- **Callbacks stay cancellable:** while a call is claimed and unanswered, a second session on the same bridge reaches the model (`finish without waiting` in that session's request). `turn/interrupt` on the blocked session returned in 24ms (Shuvcode) and 29ms (stock), under 8s, and did not answer the open call.
- **Attach takeover:** bridge #2 `startLiveBridge` on the same engine and data dir, then `thread/resume` of the same native session. The companion epoch/capability fence settles the old claimed call as `bb tool outcome unknown: owner replaced while the call was claimed` (not success, not `owner replaced`). That call is not re-dispatched to bridge #2 (`callId` differs; bridge #2 sees only the new call). `pending`, `claim`, and `result` with the old capability fail `unbound`. A late reply on bridge #1 does not reach the model. Bridge #2 round-trips `echo: new-owner`.

## Findings / deviations from plan

- The provider-bridge protocol has no `turn/interrupt`. bb's product stop is `thread/stop`, and this bridge detaches on both `intent:"interrupt"` and `intent:"release"`. The retained-interrupt path the plan describes for a native turn interrupt is proven by plugin-local `turn/interrupt` plus the engine `POST /api/session/:id/interrupt` path. Promoting `turn/interrupt` onto the protocol is a lead decision; the daemon never sends it today.
- A native interrupt's model-visible tool text is the engine's `Tool execution interrupted` (`session.tool.failed`, `type:"aborted"`, `executed:false`), not the bridge's uncertain-outcome string. The executor is already interrupted, so a companion `result` cannot become that row. The bridge still cancels the reverse call and ignores a late reply.
- Resync guard skips the whole `reconcileAfterResync` (turn boundary and open-item closes), not only the turn boundary. A natural 1024-event overflow was not forced: the pump keeps up with the subscriber buffer. The live test injects the pump's resync event, which is the path both overflow and reconnect use.
- Attach takeover does not wait for heartbeat expiry. A second `attach` for an already-bound session always replaces the owner. Heartbeat expiry remains a milestone-1 shortcut.

## Spike shortcuts left

- No owner heartbeat, so takeover cannot wait out a live owner. Fencing is the new capability plus an epoch on the binding (`attach` returns `epoch`).
- `result` on an already-settled deferred is ignored (`Deferred.doneUnsafe` returns false) instead of identical-payload idempotency.
- Unclaimed bridge cancel text `bb tool call cancelled`, unclaimed takeover text `bb tool call failed: owner replaced`, and revoke text `bb tool outcome unknown: the binding was revoked while the call was claimed` are implemented. The live cases above are the claimed paths.
- `injectResync` / `bbToolCapability` are test seams on the bridge return, not protocol methods.

## Settlement texts

| Outcome | Text |
| --- | --- |
| Bridge cancel, never dispatched | `bb tool call cancelled` |
| Bridge cancel, claimed (interrupt/stop) | `bb tool outcome unknown: claimed call was cancelled before a result arrived` |
| Takeover, unclaimed | `bb tool call failed: owner replaced` |
| Takeover, claimed | `bb tool outcome unknown: owner replaced while the call was claimed` |
| Explicit detach, claimed, if the bridge did not deliver first | `bb tool outcome unknown: the binding was revoked while the call was claimed` |
| Native interrupt, model-visible | `Tool execution interrupted` |
