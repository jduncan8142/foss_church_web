// Minimal in-memory sliding-window rate limiter keyed by client IP. Good enough
// for a single-container marketing site; resets on restart.

const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);

  // Opportunistic cleanup so the map can't grow without bound.
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length === 0) hits.delete(k);
      else hits.set(k, live);
    }
  }
  return true;
}
