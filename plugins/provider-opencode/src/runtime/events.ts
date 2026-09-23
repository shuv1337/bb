import {
  EVENT_STREAM_BACKOFF_INITIAL_MS,
  EVENT_STREAM_BACKOFF_MAX_MS,
  EVENT_STREAM_STABLE_MS,
  SSE_CONNECT_TIMEOUT_MS,
  SUBSCRIBER_BUFFER_LIMIT,
} from "./types.js";
import type { OpenCodeNativeEvent, RuntimeSessionEvent } from "./types.js";

type Subscriber = {
  sessionID: string;
  owner: EventPump;
  push: (event: RuntimeSessionEvent) => void;
  close: () => void;
  fail: (error: unknown) => void;
};

export type EventSourceFactory = (
  signal: AbortSignal,
) => AsyncIterable<unknown>;

export type EventPumpOptions = {
  isFatal?: (error: unknown) => boolean;
  describeError?: (error: unknown) => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  connectTimeoutMs?: number;
};

function describeUnknownError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "OpenCode event stream failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeNativeEvent(value: unknown): OpenCodeNativeEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const data = isRecord(value.data) ? value.data : undefined;
  const durable = isRecord(value.durable) ? value.durable : undefined;
  const seq = typeof durable?.seq === "number" ? durable.seq : undefined;
  const aggregateID =
    typeof durable?.aggregateID === "string" ? durable.aggregateID : undefined;
  const version = typeof durable?.version === "number" ? durable.version : undefined;
  return {
    type: value.type,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.created === "number" ? { created: value.created } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(durable !== undefined
      ? {
          durable: {
            ...(aggregateID !== undefined ? { aggregateID } : {}),
            ...(seq !== undefined ? { seq } : {}),
            ...(version !== undefined ? { version } : {}),
          },
        }
      : {}),
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
  private readonly adopted = new Set<Subscriber>();
  private connected = false;
  private closed = false;
  private backoffMs = EVENT_STREAM_BACKOFF_INITIAL_MS;
  private connectWaiters: Array<(ok: boolean) => void> = [];
  private streamError: unknown = null;
  private attemptError: unknown = null;
  private disconnectError: unknown = null;
  private disconnectReported = false;
  private stoppedSettled = false;
  private resolveStopped = (): void => {};
  private rejectStopped = (_error: unknown): void => {};
  private readonly stopped: Promise<void>;
  private readonly isFatal: (error: unknown) => boolean;
  private readonly describeError: (error: unknown) => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly source: EventSourceFactory,
    options: EventPumpOptions = {},
  ) {
    this.isFatal = options.isFatal ?? (() => false);
    this.describeError = options.describeError ?? describeUnknownError;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
    this.connectTimeoutMs = options.connectTimeoutMs ?? SSE_CONNECT_TIMEOUT_MS;
    this.stopped = new Promise((resolve, reject) => {
      this.resolveStopped = resolve;
      this.rejectStopped = reject;
    });
  }

  whenStopped(): Promise<void> {
    return this.stopped;
  }

  async ensureRunning(): Promise<void> {
    if (this.streamError !== null) throw this.streamError;
    if (this.closed) throw new Error("event pump closed");
    if (this.connected) return;
    if (this.connection === null) this.start();
    await this.waitUntilConnected(this.connectTimeoutMs);
  }

  fail(error: unknown): void {
    this.streamError = error;
    this.connected = false;
    const connection = this.connection;
    this.connection = null;
    connection?.abort();
    this.flushWaiters(false);
    for (const subscriber of this.subscribers) subscriber.fail(error);
    this.subscribers.clear();
    this.adopted.clear();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get lastDisconnectError(): unknown {
    return this.disconnectError;
  }

  get pendingConnectWaiters(): number {
    return this.connectWaiters.length;
  }

  adoptSubscribers(previous: EventPump): number {
    if (previous === this) return 0;
    for (const [child, parent] of previous.parentByChild) {
      this.rememberLineage(child, parent);
    }
    const moved = [...previous.subscribers];
    previous.subscribers.clear();
    previous.adopted.clear();
    for (const subscriber of moved) {
      subscriber.owner = this;
      if (this.streamError !== null) {
        subscriber.fail(this.streamError);
        continue;
      }
      this.subscribers.add(subscriber);
      this.adopted.add(subscriber);
    }
    if (this.connected) this.flushAdoptedResync();
    return moved.length;
  }

  subscribe(
    sessionID: string,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeSessionEvent> {
    const queue: RuntimeSessionEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let failure: Error | null = null;
    const subscriber: Subscriber = {
      sessionID,
      owner: this,
      push: (event) => {
        if (done || failure !== null) return;
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
      fail: (error: unknown) => {
        if (done || failure !== null) return;
        failure =
          error instanceof Error
            ? error
            : new Error("OpenCode event stream failed");
        notify?.();
      },
    };
    this.subscribers.add(subscriber);
    if (this.streamError !== null) {
      this.subscribers.delete(subscriber);
      subscriber.fail(this.streamError);
    }
    const onAbort = () => {
      subscriber.owner.subscribers.delete(subscriber);
      subscriber.owner.adopted.delete(subscriber);
      signal.removeEventListener("abort", onAbort);
      subscriber.close();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          for (;;) {
            if (failure !== null) throw failure;
            const item = queue.shift();
            if (item !== undefined) return { value: item, done: false };
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
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
    this.adopted.clear();
    this.settleStopped();
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
      let connectedAt: number | null = null;
      try {
        for await (const raw of this.source(controller.signal)) {
          if (this.closed || controller.signal.aborted) break;
          const event = decodeNativeEvent(raw);
          if (event === null) continue;
          if (event.type === "server.connected") {
            connectedAt = this.now();
            this.markConnected(reconnecting);
            reconnecting = false;
          }
          this.dispatch(event);
        }
        if (!this.closed && !controller.signal.aborted) {
          this.reportDisconnect(new Error("OpenCode event stream ended"));
        }
      } catch (error) {
        if (this.closed || controller.signal.aborted) break;
        this.connected = false;
        if (this.isFatal(error)) {
          if (this.streamError === null) this.streamError = error;
          this.flushWaiters(false);
          this.settleStopped(this.streamError);
          break;
        }
        this.attemptError = error;
        this.flushWaiters(false);
        this.attemptError = null;
        this.reportDisconnect(error);
      }
      this.connected = false;
      if (this.closed || controller.signal.aborted) break;
      if (
        connectedAt !== null &&
        this.now() - connectedAt >= EVENT_STREAM_STABLE_MS
      ) {
        this.backoffMs = EVENT_STREAM_BACKOFF_INITIAL_MS;
      }
      reconnecting = true;
      await this.sleep(this.backoffMs, controller.signal);
      this.backoffMs = Math.min(this.backoffMs * 2, EVENT_STREAM_BACKOFF_MAX_MS);
    }
  }

  private reportDisconnect(error: unknown): void {
    this.disconnectError = error;
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    const message = this.describeError(error);
    for (const subscriber of this.subscribers) {
      subscriber.push({
        kind: "stream.error",
        sessionID: subscriber.sessionID,
        message,
      });
    }
  }

  private settleStopped(error?: unknown): void {
    if (this.stoppedSettled) return;
    this.stoppedSettled = true;
    if (error !== undefined) this.rejectStopped(error);
    else this.resolveStopped();
  }

  private markConnected(reconnecting: boolean): void {
    this.connected = true;
    this.disconnectError = null;
    this.disconnectReported = false;
    this.flushWaiters(true);
    if (reconnecting) {
      this.adopted.clear();
      this.emitResync("reconnect");
      return;
    }
    this.flushAdoptedResync();
  }

  private flushAdoptedResync(): void {
    const targets = [...this.adopted];
    this.adopted.clear();
    for (const subscriber of targets) {
      subscriber.push({
        kind: "resync",
        sessionID: subscriber.sessionID,
        reason: "reconnect",
      });
    }
  }

  private async waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return;
    if (this.streamError !== null) throw this.streamError;
    await new Promise<void>((resolve, reject) => {
      const waiter = (ok: boolean): void => {
        clearTimeout(timer);
        if (ok) {
          resolve();
          return;
        }
        const failure = this.streamError ?? this.attemptError;
        if (failure !== null) {
          reject(failure);
          return;
        }
        reject(new Error("OpenCode event stream closed"));
      };
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter(
          (pending) => pending !== waiter,
        );
        reject(new Error("OpenCode event stream did not become ready"));
      }, timeoutMs);
      this.connectWaiters.push(waiter);
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
    for (const subscriber of this.subscribers) {
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
