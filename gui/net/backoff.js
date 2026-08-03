/**
 * gui/net/backoff.js — the retry schedule, shared by both ends.
 *
 * The client uses it to redial a host that has gone away; the host uses it to
 * re-claim a room code the broker has not released yet. Those are the same
 * problem from opposite sides, and they should back off identically — if the
 * host is slower to come back than the clients are to give up, a refresh looks
 * like a crash.
 *
 * Its own module rather than a corner of the connection manager, because a
 * host importing the *client* transport to borrow one function is a dependency
 * that reads as a mistake even when it works.
 */

/**
 * Doubling delay, capped. `attempt` is 0-indexed, so the first retry is the
 * initial delay rather than twice it.
 *
 * @param {number} attempt
 * @param {number} [initialMs]
 * @param {number} [maxMs]
 */
export function nextBackoffDelay(attempt, initialMs = 100, maxMs = 30_000) {
  return Math.min(initialMs * 2 ** Math.max(0, attempt), maxMs);
}
