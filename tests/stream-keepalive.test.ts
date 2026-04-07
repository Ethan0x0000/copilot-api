import { afterEach, describe, expect, test } from "bun:test"

import {
  consumeWithKeepAlive,
  getStreamKeepAliveOptions,
  type StreamKeepAliveCallbacks,
} from "~/lib/stream-keepalive"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an async iterable from a list of values, yielded synchronously. */
function* fromArraySync<T>(items: Array<T>): Generator<T> {
  for (const item of items) {
    yield item
  }
}

/** Wraps a sync generator into an async iterable. */
async function* fromArray<T>(items: Array<T>): AsyncGenerator<T> {
  for (const item of fromArraySync(items)) {
    yield await Promise.resolve(item)
  }
}

/** Async generator that yields one value then throws. */
async function* errorStream(): AsyncGenerator<string> {
  yield await Promise.resolve("ok")
  throw new Error("upstream failed")
}

/**
 * Creates a controllable async iterable where values are pushed manually.
 * `push(value)` enqueues a value; `end()` signals completion.
 */
function createControllableStream<T>(): {
  push: (value: T) => void
  end: () => void
  iterable: AsyncIterable<T>
} {
  type QueueItem = { kind: "value"; value: T } | { kind: "end" }
  const queue: Array<QueueItem> = []
  let waiter: ((item: QueueItem) => void) | null = null

  function dequeue(): Promise<QueueItem> {
    const head = queue.shift()
    if (head) return Promise.resolve(head)
    return new Promise((resolve) => {
      waiter = resolve
    })
  }

  function enqueue(item: QueueItem) {
    if (waiter) {
      const w = waiter
      waiter = null
      w(item)
    } else {
      queue.push(item)
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          const item = await dequeue()
          if (item.kind === "end") return { done: true, value: undefined }
          return { done: false, value: item.value }
        },
        return(): Promise<IteratorResult<T>> {
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }

  return {
    push: (value: T) => enqueue({ kind: "value", value }),
    end: () => enqueue({ kind: "end" }),
    iterable,
  }
}

/** Collect events and heartbeats into arrays for assertions. */
function createTracker<T>() {
  const events: Array<T> = []
  const heartbeats: Array<number> = []
  let idleTimedOut = false

  const callbacks: StreamKeepAliveCallbacks<T> = {
    onEvent: (event) => {
      events.push(event)
      return Promise.resolve(true)
    },
    onHeartbeat: () => {
      heartbeats.push(Date.now())
      return Promise.resolve()
    },
    onIdleTimeout: () => {
      idleTimedOut = true
      return Promise.resolve()
    },
  }

  return { events, heartbeats, callbacks, getIdleTimedOut: () => idleTimedOut }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getStreamKeepAliveOptions", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("returns defaults when env vars are not set", () => {
    delete process.env.COPILOT_API_STREAM_HEARTBEAT_INTERVAL_MS
    delete process.env.COPILOT_API_STREAM_IDLE_TIMEOUT_MS

    const opts = getStreamKeepAliveOptions()
    expect(opts.heartbeatIntervalMs).toBe(15_000)
    expect(opts.idleTimeoutMs).toBe(300_000)
  })

  test("reads env vars when set", () => {
    process.env.COPILOT_API_STREAM_HEARTBEAT_INTERVAL_MS = "5000"
    process.env.COPILOT_API_STREAM_IDLE_TIMEOUT_MS = "60000"

    const opts = getStreamKeepAliveOptions()
    expect(opts.heartbeatIntervalMs).toBe(5000)
    expect(opts.idleTimeoutMs).toBe(60000)
  })

  test("falls back to defaults on invalid env values", () => {
    process.env.COPILOT_API_STREAM_HEARTBEAT_INTERVAL_MS = "not-a-number"
    process.env.COPILOT_API_STREAM_IDLE_TIMEOUT_MS = ""

    const opts = getStreamKeepAliveOptions()
    expect(opts.heartbeatIntervalMs).toBe(15_000)
    expect(opts.idleTimeoutMs).toBe(300_000)
  })

  test("accepts 0 to disable heartbeat", () => {
    process.env.COPILOT_API_STREAM_HEARTBEAT_INTERVAL_MS = "0"
    process.env.COPILOT_API_STREAM_IDLE_TIMEOUT_MS = "0"

    const opts = getStreamKeepAliveOptions()
    expect(opts.heartbeatIntervalMs).toBe(0)
    expect(opts.idleTimeoutMs).toBe(0)
  })
})

describe("consumeWithKeepAlive", () => {
  test("passes all events through when upstream is fast", async () => {
    const data = ["a", "b", "c"]
    const tracker = createTracker<string>()

    await consumeWithKeepAlive(
      fromArray(data),
      {
        heartbeatIntervalMs: 1000,
        idleTimeoutMs: 5000,
      },
      tracker.callbacks,
    )

    expect(tracker.events).toEqual(["a", "b", "c"])
    expect(tracker.heartbeats).toHaveLength(0)
    expect(tracker.getIdleTimedOut()).toBe(false)
  })

  test("works with heartbeat disabled (interval = 0)", async () => {
    const data = [1, 2, 3]
    const tracker = createTracker<number>()

    await consumeWithKeepAlive(
      fromArray(data),
      {
        heartbeatIntervalMs: 0,
        idleTimeoutMs: 5000,
      },
      tracker.callbacks,
    )

    expect(tracker.events).toEqual([1, 2, 3])
    expect(tracker.heartbeats).toHaveLength(0)
  })

  test("stops when onEvent returns false", async () => {
    const data = ["a", "b", "STOP", "c"]
    const events: Array<string> = []

    await consumeWithKeepAlive(
      fromArray(data),
      {
        heartbeatIntervalMs: 1000,
        idleTimeoutMs: 5000,
      },
      {
        onEvent: (event) => {
          events.push(event)
          return Promise.resolve(event !== "STOP")
        },
        onHeartbeat: () => Promise.resolve(),
        onIdleTimeout: () => Promise.resolve(),
      },
    )

    expect(events).toEqual(["a", "b", "STOP"])
  })

  test("emits heartbeats when upstream is slow", async () => {
    const { push, end, iterable } = createControllableStream<string>()
    const tracker = createTracker<string>()

    const consumePromise = consumeWithKeepAlive(
      iterable,
      {
        heartbeatIntervalMs: 50,
        idleTimeoutMs: 5000,
      },
      tracker.callbacks,
    )

    // Wait for a few heartbeats
    await new Promise((r) => setTimeout(r, 180))

    // Push data and end
    push("data")
    end()

    await consumePromise

    expect(tracker.events).toEqual(["data"])
    // Should have emitted at least 2 heartbeats in ~180ms with 50ms interval
    expect(tracker.heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(tracker.getIdleTimedOut()).toBe(false)
  })

  test("triggers idle timeout when upstream is silent too long", async () => {
    const { iterable, end } = createControllableStream<string>()
    const tracker = createTracker<string>()

    const consumePromise = consumeWithKeepAlive(
      iterable,
      {
        heartbeatIntervalMs: 30,
        idleTimeoutMs: 100,
      },
      tracker.callbacks,
    )

    await consumePromise

    expect(tracker.events).toHaveLength(0)
    expect(tracker.getIdleTimedOut()).toBe(true)
    // Should have had some heartbeats before timeout
    expect(tracker.heartbeats.length).toBeGreaterThanOrEqual(1)

    // Clean up the stream
    end()
  })

  test("resets idle timer on each real event", async () => {
    const { push, end, iterable } = createControllableStream<string>()
    const tracker = createTracker<string>()

    const consumePromise = consumeWithKeepAlive(
      iterable,
      {
        heartbeatIntervalMs: 40,
        idleTimeoutMs: 120,
      },
      tracker.callbacks,
    )

    // Push events at intervals shorter than idle timeout
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 60))
      push(`event-${i}`)
    }
    end()

    await consumePromise

    // All events should have been received (idle timeout didn't fire)
    expect(tracker.events).toEqual(["event-0", "event-1", "event-2"])
    expect(tracker.getIdleTimedOut()).toBe(false)
    // Some heartbeats may have fired during the 60ms waits
    expect(tracker.heartbeats.length).toBeGreaterThanOrEqual(1)
  })

  test("handles empty upstream stream", async () => {
    const tracker = createTracker<string>()

    await consumeWithKeepAlive(
      fromArray([]),
      {
        heartbeatIntervalMs: 50,
        idleTimeoutMs: 5000,
      },
      tracker.callbacks,
    )

    expect(tracker.events).toHaveLength(0)
    expect(tracker.heartbeats).toHaveLength(0)
    expect(tracker.getIdleTimedOut()).toBe(false)
  })

  test("handles upstream error propagation", async () => {
    const tracker = createTracker<string>()

    let caught: Error | undefined
    try {
      await consumeWithKeepAlive(
        errorStream(),
        {
          heartbeatIntervalMs: 1000,
          idleTimeoutMs: 5000,
        },
        tracker.callbacks,
      )
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeDefined()
    expect(caught?.message).toBe("upstream failed")
    expect(tracker.events).toEqual(["ok"])
  })
})
