// Tests for the in-memory sliding-window rate limiter (WEB-002 coverage extension).
// `rateLimit` is the only brute-force / spam throttle in front of the live,
// unauthenticated `/api/contact` PII endpoint, so its window semantics are
// security-relevant and were previously uncovered. The function is pure and
// time-injected (`now` is a parameter), so these assertions are deterministic.
//
// NB: the module keeps a process-global `hits` Map, so every test uses a unique
// key namespace to stay isolated from the others (mirroring real per-IP keying).
import { describe, expect, test } from "bun:test";
import { rateLimit } from "./rateLimit.ts";

describe("rateLimit", () => {
  test("allows up to `max` requests inside the window, then rejects", () => {
    const key = "cap-ip";
    const max = 3;
    const w = 1000;
    expect(rateLimit(key, max, w, 0)).toBe(true); // 1st
    expect(rateLimit(key, max, w, 10)).toBe(true); // 2nd
    expect(rateLimit(key, max, w, 20)).toBe(true); // 3rd
    expect(rateLimit(key, max, w, 30)).toBe(false); // 4th — over the limit
    expect(rateLimit(key, max, w, 40)).toBe(false); // still blocked
  });

  test("keys are independent (one IP hitting the limit doesn't throttle another)", () => {
    const w = 1000;
    expect(rateLimit("iso-a", 1, w, 0)).toBe(true);
    expect(rateLimit("iso-a", 1, w, 1)).toBe(false); // A is now blocked
    expect(rateLimit("iso-b", 1, w, 1)).toBe(true); // B is unaffected
    expect(rateLimit("iso-b", 1, w, 2)).toBe(false); // B blocks on its own count
  });

  test("the window slides: capacity returns once old hits age out", () => {
    const key = "slide-ip";
    const max = 3;
    const w = 1000;
    rateLimit(key, max, w, 0); // hit @0
    rateLimit(key, max, w, 10); // hit @10
    rateLimit(key, max, w, 20); // hit @20
    expect(rateLimit(key, max, w, 30)).toBe(false); // full

    // At now=1000 the @0 hit is exactly windowMs old → expired (strict `< windowMs`),
    // so one slot frees up and the request is admitted again.
    expect(rateLimit(key, max, w, 1000)).toBe(true);
    // @10 and @20 are still live (990ms / 980ms old) plus the new @1000 → full again.
    expect(rateLimit(key, max, w, 1001)).toBe(false);
  });

  test("expiry boundary is strict: a hit exactly windowMs old no longer counts", () => {
    const w = 1000;
    expect(rateLimit("edge-ip", 1, w, 0)).toBe(true); // hit @0
    expect(rateLimit("edge-ip", 1, w, 999)).toBe(false); // 999ms old, still counts
    expect(rateLimit("edge-ip", 1, w, 1000)).toBe(true); // 1000ms old → expired
  });

  test("rejected requests are not recorded, so they never extend the block", () => {
    const key = "noextend-ip";
    const w = 1000;
    expect(rateLimit(key, 1, w, 0)).toBe(true); // hit @0
    expect(rateLimit(key, 1, w, 500)).toBe(false); // rejected — must NOT push @500
    expect(rateLimit(key, 1, w, 900)).toBe(false); // rejected — must NOT push @900
    // If a rejected attempt had been recorded, the window would slide off @900 and
    // the block would persist past 1000. Because rejects aren't recorded, the only
    // live hit is @0, which expires at exactly 1000 → admitted.
    expect(rateLimit(key, 1, w, 1000)).toBe(true);
  });

  test("max of 0 rejects every request", () => {
    expect(rateLimit("zero-ip", 0, 1000, 0)).toBe(false);
    expect(rateLimit("zero-ip", 0, 1000, 5000)).toBe(false);
  });
});
