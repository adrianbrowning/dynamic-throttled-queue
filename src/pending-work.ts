export type PendingWorkOptions = {
  /** Most items that may hold a reservation at once, counting queued, held and active items. */
  capacity: number;
  /** Dead queue slots tolerated before the queue compacts. */
  compactThreshold: number;
};

export type PendingWorkHost = {
  /** A retry joined the queue, either straight from `settle` or once its delay elapsed. */
  retryQueued: () => void;
};

/** How an ended attempt continues: queued again now, or held for `delay` ms first. */
export type Retry<T> = Readonly<{ item: T; delay?: number; }>;

/**
 * Accepted work that has not reached a terminal outcome: queued items in FIFO order, retries held
 * for a delay, and active items that have started but not settled. Each item keeps one capacity
 * reservation from `accept` until it settles without a retry.
 */
export type PendingWork<T> = {
  /** Items that can start now. Held retries are not queued until their delay elapses. */
  readonly queued: number;
  /** Queued items plus held retries. */
  readonly pending: number;
  /** Items taken that have not settled. */
  readonly active: number;
  /** Reserves capacity and queues `item`. Throws when every reservation is taken. */
  accept: (item: T) => void;
  /** Makes the oldest queued item active and returns it, or `undefined` when nothing is queued. */
  take: () => T | undefined;
  /** Drops `item`, which must be queued or held, and releases its reservation. */
  remove: (item: T) => void;
  /**
   * Ends one active item. `decide` runs once the item no longer counts as active but still holds its
   * reservation; returning a retry keeps that reservation, returning nothing releases it. `observe`
   * runs after the retry is placed and before idle is checked: work it accepts keeps idle waiters
   * pending, and `fail` called from inside it rejects them.
   */
  settle: (decide?: () => Retry<T> | undefined, observe?: () => void) => void;
  /** Stops held-retry delays from elapsing, keeping each one's remaining time. */
  freeze: () => void;
  /** Resumes held-retry delays from their remaining time. Retries held while frozen wait for this. */
  thaw: () => void;
  /** Drops queued items and held retries. Active items still settle, and idle waits for them. */
  discard: () => void;
  /** Drops queued items and held retries, and rejects current idle waiters with `error`. */
  fail: (error: unknown) => void;
  /** Resolves once nothing is queued, held or active. */
  whenIdle: () => Promise<void>;
};

type HeldRetry<T> = {
  item: T;
  remaining: number;
  due: number;
  timeout?: ReturnType<typeof setTimeout>;
};

export function createPendingWork<T>(options: PendingWorkOptions, host: PendingWorkHost): PendingWork<T> {
  const { capacity, compactThreshold } = options;
  const queue: Array<T> = [];
  let head = 0;
  /** Queued items that were removed but still sit between `head` and the tail; `take` skips them. */
  const removed = new Set<T>();
  const held: Array<HeldRetry<T>> = [];
  let frozen = false;
  let active = 0;
  /** Items between leaving `active` and having their retry placed; they keep their reservation. */
  let deciding = 0;
  const idleWaiters: Array<PromiseWithResolvers<void>> = [];

  function queued() {
    return queue.length - head - removed.size;
  }

  function pending() {
    return queued() + held.length;
  }

  function isIdle() {
    return active === 0 && pending() === 0;
  }

  function notifyIdle() {
    if (!isIdle()) return;
    for (const waiter of idleWaiters.splice(0)) waiter.resolve();
  }

  function releaseHeld(retry: HeldRetry<T>) {
    held.splice(held.indexOf(retry), 1);
    queue.push(retry.item);
    host.retryQueued();
  }

  function startHeld(retry: HeldRetry<T>) {
    retry.due = Date.now() + retry.remaining;
    retry.timeout = setTimeout(() => releaseHeld(retry), retry.remaining);
  }

  function hold(item: T, delay: number) {
    const retry: HeldRetry<T> = { item, remaining: delay, due: 0 };
    held.push(retry);
    if (!frozen) startHeld(retry);
  }

  function drop() {
    for (const retry of held) clearTimeout(retry.timeout);
    held.length = 0;
    queue.length = 0;
    head = 0;
    removed.clear();
  }

  function compact() {
    if (head === queue.length) {
      queue.length = 0;
      head = 0;
    }
    else if (head > compactThreshold && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }
  }

  return {
    get queued() {
      return queued();
    },
    get pending() {
      return pending();
    },
    get active() {
      return active;
    },
    accept(item) {
      if (pending() + active + deciding >= capacity) throw new Error("Cannot enqueue work: maxQueueSize has been reached");
      queue.push(item);
    },
    take() {
      while (head < queue.length) {
        const item = queue[head++]!;
        if (removed.delete(item)) continue;
        active++;
        compact();
        return item;
      }
      compact();
      return undefined;
    },
    remove(item) {
      const index = held.findIndex(retry => retry.item === item);
      if (index === -1) removed.add(item);
      else clearTimeout(held.splice(index, 1)[0]!.timeout);
      notifyIdle();
    },
    settle(decide, observe) {
      active--;
      deciding++;
      let retry: Retry<T> | undefined;
      try {
        retry = decide?.();
      }
      finally {
        deciding--;
      }
      if (retry?.delay !== undefined) hold(retry.item, retry.delay);
      else if (retry) {
        queue.push(retry.item);
        host.retryQueued();
      }
      observe?.();
      notifyIdle();
    },
    freeze() {
      frozen = true;
      for (const retry of held) {
        if (retry.timeout === undefined) continue;
        clearTimeout(retry.timeout);
        retry.timeout = undefined;
        retry.remaining = Math.max(0, retry.due - Date.now());
      }
    },
    thaw() {
      frozen = false;
      for (const retry of held) {
        if (retry.timeout === undefined) startHeld(retry);
      }
    },
    discard() {
      drop();
      notifyIdle();
    },
    fail(error) {
      drop();
      for (const waiter of idleWaiters.splice(0)) waiter.reject(error);
    },
    async whenIdle() {
      if (isIdle()) return;
      const waiter = Promise.withResolvers<void>();
      idleWaiters.push(waiter);
      return waiter.promise;
    },
  };
}
