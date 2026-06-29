// Tests for the Cloudflare Turnstile server-side verifier (WEB-002 coverage extension).
// `verifyTurnstile` is the captcha check guarding the live, unauthenticated
// `/api/contact` PII endpoint (see WEB-005/WEB-006). It was the only
// security-sensitive module with no coverage on `main`. The function is async and
// calls `fetch`, so these tests inject a mocked `globalThis.fetch` to stay
// deterministic and offline; the load-bearing invariant is that it **fails
// CLOSED** — every non-explicit-success path (network error, malformed body,
// missing/non-boolean `success`, empty token) returns `false`, never `true`.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { verifyTurnstile } from "./turnstile.ts";

const realFetch = globalThis.fetch;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Install a fetch stub that records the outgoing request and replies with a
// caller-supplied body (or a thrown error, to exercise the fail-closed catch).
function stubFetch(reply: { json: () => unknown } | Error) {
  const calls: Array<{
    url: string;
    body: URLSearchParams;
    init: RequestInit;
  }> = [];
  const fn = mock(async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as URLSearchParams, init });
    if (reply instanceof Error) throw reply;
    return { json: async () => reply.json() } as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("verifyTurnstile", () => {
  test("an empty token fails closed WITHOUT calling Cloudflare", async () => {
    const calls = stubFetch({ json: () => ({ success: true }) });
    expect(await verifyTurnstile("", "1.2.3.4")).toBe(false);
    expect(calls.length).toBe(0); // no wasted upstream round-trip
  });

  test("a successful siteverify ({success:true}) returns true", async () => {
    const calls = stubFetch({ json: () => ({ success: true }) });
    expect(await verifyTurnstile("good-token", "1.2.3.4")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(SITEVERIFY);
    expect(calls[0].init.method).toBe("POST");
    // The token is forwarded as `response`; the secret param is always present.
    expect(calls[0].body.get("response")).toBe("good-token");
    expect(calls[0].body.has("secret")).toBe(true);
  });

  test("an explicit failure ({success:false}) returns false", async () => {
    stubFetch({
      json: () => ({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    });
    expect(await verifyTurnstile("bad-token", "1.2.3.4")).toBe(false);
  });

  test("a missing `success` field fails closed", async () => {
    stubFetch({ json: () => ({}) });
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
  });

  test("a non-boolean truthy `success` fails closed (strict === true)", async () => {
    // A spoofed/garbled body must not be coerced into a pass.
    stubFetch({ json: () => ({ success: "true" }) });
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
  });

  test("a network/fetch error fails closed", async () => {
    stubFetch(new Error("ECONNRESET"));
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
  });

  test("a malformed (non-JSON) response body fails closed", async () => {
    globalThis.fetch = mock(
      async () =>
        ({
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
  });

  test("the client IP is forwarded as `remoteip` when known", async () => {
    const calls = stubFetch({ json: () => ({ success: true }) });
    await verifyTurnstile("tok", "203.0.113.7");
    expect(calls[0].body.get("remoteip")).toBe("203.0.113.7");
  });

  test('`remoteip` is omitted when the IP is "unknown" or empty', async () => {
    const calls = stubFetch({ json: () => ({ success: true }) });
    await verifyTurnstile("tok", "unknown");
    expect(calls[0].body.has("remoteip")).toBe(false);

    const calls2 = stubFetch({ json: () => ({ success: true }) });
    await verifyTurnstile("tok", "");
    expect(calls2[0].body.has("remoteip")).toBe(false);
  });
});
