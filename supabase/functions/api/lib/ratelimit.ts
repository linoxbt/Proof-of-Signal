// Fixed-window in-memory rate limiter, per Edge Function isolate.
//
// Used for per-IP limits only. It is best-effort: each isolate keeps its own
// counters and they reset when the isolate is recycled, so the effective limit
// is (limit x live isolates). The per-device nonce limit, which the contract
// fixes at 30 per hour, is enforced exactly from the `nonces` table instead.

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private windowMs = 3_600_000, private maxKeys = 50_000) {}

  /** Counts one hit. Returns 0 when allowed, else seconds until the window resets. */
  hit(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return (w.resetAt - now) / 1000;
    w.count++;
    return 0;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
