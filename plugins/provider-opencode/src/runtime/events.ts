import { SSE_CONNECT_TIMEOUT_MS, SUBSCRIBER_BUFFER_LIMIT } from "./types.js";
import type { OpenCodeNativeEvent, RuntimeSessionEvent } from "./types.js";

type Subscriber = {
  sessionID: string;
  push: (event: RuntimeSessionEvent) => void;
  close: () => void;
};

export type EventSourceFactory = (
  signal: AbortSignal,
) => AsyncIterable<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeNativeEvent(value: unknown): OpenCodeNativeEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const data = isRecord(value.data) ? value.data : undefined;
  return {
    type: value.type,
    id: typeof value.id === "string" ? value.id : undefined,
    created: typeof value.created === "number" ? value.created : undefined,
    data,
  };
}

export function sessionIdOf(event: OpenCodeNativeEvent): string | undefined {
  const data = event.data;
  if (!data) return undefined;
  if (typeof data.sessionID === "string") return data.sessionID;
  if (event.type === "session.created" && typeof data.id === "string") {
    return data.id;
  }
  const form = data.form;
  if (isRecord(form) && typeof form.sessionID === "string") return form.sessionID;
  return undefined;
}

export function parentIdOf(event: OpenCodeNativeEvent): string | undefined {
  const data = event.data;
  if (!data) return undefined;
  if (typeof data.parentID === "string") return data.parentID;
  return undefined;
}

export class EventPump {
  private readonly subscribers = new Set<Subscriber>();
  private readonly parentByChild = new Map<string, string>();
  private readonly descendantsByAncestor = new Map<string, Set<string>>();
  private connection: AbortController | null = null;
  private running: Promise<void> | null = null;
  private connected = false;
  private sawConnected = false;
  private closed = false;
  private backoffMs = 250;
  private connectWaiters: Array<(ok: boolean) => void> = [];

  constructor(private readonly source: EventSourceFactory) {}

  async ensureRunning(): Promise<void> {
    if (this.closed) throw new Error("event pump closed");
    if (this.connected) return;
    if (this.connection === null) this.start();
    await this.waitUntilConnected(SSE_CONNECT_TIMEOUT_MS);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  subscribe(
    sessionID: string,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeSessionEvent> {
    const queue: RuntimeSessionEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const subscriber: Subscriber = {
      sessionID,
      push: (event) => {
        if (done) return;
        if (queue.length >= SUBSCRIBER_BUFFER_LIMIT) {
          queue.length = 0;
          queue.push({
            kind: "resync",
            sessionID,
            reason: "overflow",
          });
        } else {
          queue.push(event);
        }
        notify?.();
      },
      close: () => {
        done = true;
        notify?.();
      },
    };
    this.subscribers.add(subscriber);
    const onAbort = () => {
      this.subscribers.delete(subscriber);
      signal.removeEventListener("abort", onAbort);
      subscriber.close();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (!done || queue.length > 0) {
            const item = queue.shift();
            if (item) return { value: item, done: false };
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
          return { value: undefined, done: true };
        },
        return: async () => {
          onAbort();
          return { value: undefined, done: true };
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.connection?.abort();
    this.connection = null;
    this.parentByChild.clear();
    this.descendantsByAncestor.clear();
    this.flushWaiters(false);
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
    await this.running?.catch(() => undefined);
  }

  private start(): void {
    const controller = new AbortController();
    this.connection = controller;
    this.running = this.loop(controller);
  }

  private async loop(controller: AbortController): Promise<void> {
    let reconnecting = false;
    while (!this.closed && !controller.signal.aborted) {
      this.connected = false;
      this.sawConnected = false;
      try {
        for await (const raw of this.source(controller.signal)) {
          if (this.closed || controller.signal.aborted) break;
          const event = decodeNativeEvent(raw);
          if (event === null) continue;
          this.backoffMs = 250;
          if (event.type === "server.connected") {
            this.markConnected(reconnecting);
            reconnecting = false;
          }
          this.dispatch(event);
        }
      } catch {
        if (this.closed || controller.signal.aborted) break;
      }
      this.connected = false;
      if (this.closed || controller.signal.aborted) break;
      reconnecting = true;
      await delay(this.backoffMs, controller.signal);
      this.backoffMs = Math.min(this.backoffMs * 2, 8_000);
    }
  }

  private markConnected(reconnecting: boolean): void {
    this.connected = true;
    this.sawConnected = true;
    this.flushWaiters(true);
    if (reconnecting) this.emitResync("reconnect");
  }

  private async waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("OpenCode event stream did not become ready"));
      }, timeoutMs);
      this.connectWaiters.push((ok) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error("OpenCode event stream closed"));
      });
    });
  }

  private flushWaiters(ok: boolean): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const waiter of waiters) waiter(ok);
  }

  private rememberLineage(sessionID: string, parentID: string): void {
    this.parentByChild.set(sessionID, parentID);
    let ancestor: string | undefined = parentID;
    while (ancestor !== undefined) {
      const set = this.descendantsByAncestor.get(ancestor) ?? new Set();
      set.add(sessionID);
      this.descendantsByAncestor.set(ancestor, set);
      ancestor = this.parentByChild.get(ancestor);
    }
  }

  private dispatch(event: OpenCodeNativeEvent): void {
    const sessionID = sessionIdOf(event);
    const parentID = parentIdOf(event);
    if (sessionID !== undefined && parentID !== undefined) {
      this.rememberLineage(sessionID, parentID);
    }
    const resolvedParent =
      parentID ??
      (sessionID !== undefined ? this.parentByChild.get(sessionID) : undefined);
    for (const subscriber of this.subscribers) {
      if (this.matches(subscriber.sessionID, sessionID, resolvedParent)) {
        subscriber.push({
          kind: "native",
          sessionID: sessionID ?? subscriber.sessionID,
          parentID: resolvedParent,
          event,
        });
      }
    }
  }

  private matches(
    target: string,
    sessionID: string | undefined,
    parentID: string | undefined,
  ): boolean {
    if (sessionID === target || parentID === target) return true;
    if (sessionID !== undefined) {
      const descendants = this.descendantsByAncestor.get(target);
      if (descendants?.has(sessionID)) return true;
    }
    return false;
  }

  private emitResync(reason: "reconnect" | "overflow"): void {
    const seen = new Set<string>();
    for (const subscriber of this.subscribers) {
      if (seen.has(subscriber.sessionID)) continue;
      seen.add(subscriber.sessionID);
      subscriber.push({
        kind: "resync",
        sessionID: subscriber.sessionID,
        reason,
      });
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
