import { createHandlerLogger } from "~/lib/logger"

const logger = createHandlerLogger("stream-keepalive")

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_IDLE_TIMEOUT_MS = 300_000

export interface StreamKeepAliveOptions {
  /** Interval between heartbeat pings when upstream is silent (ms). 0 = disabled. */
  heartbeatIntervalMs: number
  /** Max time to wait for any upstream event before aborting (ms). 0 = disabled. */
  idleTimeoutMs: number
}

export function getStreamKeepAliveOptions(): StreamKeepAliveOptions {
  const heartbeatRaw = process.env.COPILOT_API_STREAM_HEARTBEAT_INTERVAL_MS
  const idleRaw = process.env.COPILOT_API_STREAM_IDLE_TIMEOUT_MS

  const heartbeatInterval =
    heartbeatRaw ? Number.parseInt(heartbeatRaw, 10) : Number.NaN
  const idleTimeout = idleRaw ? Number.parseInt(idleRaw, 10) : Number.NaN

  return {
    heartbeatIntervalMs:
      Number.isFinite(heartbeatInterval) && heartbeatInterval >= 0 ?
        heartbeatInterval
      : DEFAULT_HEARTBEAT_INTERVAL_MS,
    idleTimeoutMs:
      Number.isFinite(idleTimeout) && idleTimeout >= 0 ?
        idleTimeout
      : DEFAULT_IDLE_TIMEOUT_MS,
  }
}

export interface StreamKeepAliveCallbacks<T> {
  /** Process an upstream event. Return false to stop consuming. */
  onEvent: (event: T) => Promise<boolean>
  /** Send a heartbeat/keepalive ping downstream. */
  onHeartbeat: () => Promise<void>
  /** Handle idle timeout — emit error event and stop. */
  onIdleTimeout: () => Promise<void>
}

/**
 * Consumes an async iterable while injecting heartbeat callbacks when upstream
 * goes silent. If no event arrives within `idleTimeoutMs`, calls `onIdleTimeout`
 * and stops iteration.
 *
 * This prevents downstream SSE clients from timing out when upstream is
 * generating large tool inputs (e.g., Claude writing files via tool_use).
 */
export async function consumeWithKeepAlive<T>(
  upstream: AsyncIterable<T>,
  options: StreamKeepAliveOptions,
  callbacks: StreamKeepAliveCallbacks<T>,
): Promise<void> {
  const { heartbeatIntervalMs, idleTimeoutMs } = options
  const { onEvent, onHeartbeat, onIdleTimeout } = callbacks

  // If heartbeat is disabled, consume normally with only idle timeout
  if (heartbeatIntervalMs <= 0) {
    for await (const event of upstream) {
      const shouldContinue = await onEvent(event)
      if (!shouldContinue) return
    }
    return
  }

  const iterator = upstream[Symbol.asyncIterator]()
  let lastEventTime = Date.now()
  let pendingNext = iterator.next()
  let dataPromise: Promise<{
    kind: "data"
    result: IteratorResult<T>
  }> | null = null

  try {
    while (true) {
      const elapsed = Date.now() - lastEventTime

      // Check idle timeout
      if (idleTimeoutMs > 0 && elapsed >= idleTimeoutMs) {
        logger.warn(
          `Upstream idle for ${elapsed}ms (timeout: ${idleTimeoutMs}ms)`,
        )
        await onIdleTimeout()
        return
      }

      // Calculate delay until next heartbeat
      const nextHeartbeatDelay = Math.max(0, heartbeatIntervalMs - elapsed)

      // Cache the wrapped data promise so we don't re-wrap on heartbeat loops
      dataPromise ??= pendingNext.then((result) => ({
        kind: "data" as const,
        result,
      }))

      let timerId: ReturnType<typeof setTimeout> | undefined
      const timerPromise = new Promise<{ kind: "tick" }>((resolve) => {
        timerId = setTimeout(
          () => resolve({ kind: "tick" }),
          nextHeartbeatDelay,
        )
      })

      const winner = await Promise.race([dataPromise, timerPromise])

      // Always clean up the timer to prevent leaks
      if (timerId !== undefined) {
        clearTimeout(timerId)
      }

      if (winner.kind === "tick") {
        await onHeartbeat()
        continue
      }

      // Data arrived — reset timer and process
      lastEventTime = Date.now()
      dataPromise = null

      if (winner.result.done) {
        return
      }

      const shouldContinue = await onEvent(winner.result.value)
      if (!shouldContinue) {
        return
      }

      pendingNext = iterator.next()
    }
  } finally {
    // Suppress unhandled rejections from any pending iterator promise
    pendingNext.catch(() => {})

    // Signal upstream iterator to release resources (close fetch body, etc.)
    try {
      await iterator.return?.()
    } catch {
      // Ignore cleanup errors
    }
  }
}
