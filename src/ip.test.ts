// Tests for the trusted-proxy / client-IP resolution (WEB-002). This is the
// security-sensitive logic that decides when X-Forwarded-For may be believed;
// a regression here would let a hostile client spoof its rate-limit identity.
import { describe, expect, test } from "bun:test";
import { ipv4ToInt, inCidr, isTrustedProxy, resolveClientIp } from "./ip.ts";

// The production default trusted-proxy allowlist (config.ts). fc_external (a
// non-RFC1918 Docker subnet) is supplied via env in prod and exercised below.
const DEFAULT_CIDRS = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

describe("ipv4ToInt", () => {
  test("parses dotted quads", () => {
    expect(ipv4ToInt("0.0.0.0")).toBe(0);
    expect(ipv4ToInt("255.255.255.255")).toBe(0xffffffff);
    expect(ipv4ToInt("192.168.0.1")).toBe(((192 * 256 + 168) * 256 + 0) * 256 + 1);
  });
  test("rejects non-IPv4 / out-of-range octets", () => {
    expect(ipv4ToInt("256.0.0.1")).toBeNull();
    expect(ipv4ToInt("10.0.0")).toBeNull();
    expect(ipv4ToInt("::1")).toBeNull();
    expect(ipv4ToInt("not-an-ip")).toBeNull();
    expect(ipv4ToInt("")).toBeNull();
  });
});

describe("inCidr", () => {
  test("IPv4 membership across prefix lengths", () => {
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(inCidr("172.16.5.5", "172.16.0.0/12")).toBe(true);
    expect(inCidr("172.32.0.1", "172.16.0.0/12")).toBe(false); // just outside the /12
    expect(inCidr("192.168.0.41", "192.168.0.0/16")).toBe(true);
  });
  test("/32 is exact match, /0 matches everything", () => {
    expect(inCidr("8.8.8.8", "8.8.8.8/32")).toBe(true);
    expect(inCidr("8.8.8.9", "8.8.8.8/32")).toBe(false);
    expect(inCidr("8.8.8.8", "8.8.8.8")).toBe(true); // no suffix => /32
    expect(inCidr("203.0.113.7", "0.0.0.0/0")).toBe(true);
  });
  test("IPv6 only matches the exact address", () => {
    expect(inCidr("::1", "::1/128")).toBe(true);
    expect(inCidr("::2", "::1/128")).toBe(false);
  });
  test("malformed inputs are rejected, not thrown", () => {
    expect(inCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(inCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
    expect(inCidr("garbage", "10.0.0.0/8")).toBe(false);
  });
});

describe("isTrustedProxy", () => {
  test("loopback and RFC1918 peers are trusted", () => {
    expect(isTrustedProxy("::1", DEFAULT_CIDRS)).toBe(true);
    expect(isTrustedProxy("127.0.0.1", DEFAULT_CIDRS)).toBe(true);
    expect(isTrustedProxy("192.168.0.41", DEFAULT_CIDRS)).toBe(true);
  });
  test("unwraps IPv4-mapped IPv6 before matching", () => {
    expect(isTrustedProxy("::ffff:10.0.0.5", DEFAULT_CIDRS)).toBe(true);
    expect(isTrustedProxy("::ffff:8.8.8.8", DEFAULT_CIDRS)).toBe(false);
  });
  test("public peers are NOT trusted", () => {
    expect(isTrustedProxy("8.8.8.8", DEFAULT_CIDRS)).toBe(false);
    expect(isTrustedProxy("203.0.113.7", DEFAULT_CIDRS)).toBe(false);
  });
  test("honors a custom allowlist (e.g. the non-RFC1918 fc_external Docker subnet)", () => {
    // fc_external falls OUTSIDE RFC1918, so it must be supplied explicitly; use
    // a CGNAT range (100.64.0.0/10) as a stand-in that the defaults don't cover.
    const cidrs = [...DEFAULT_CIDRS, "100.64.0.0/16"];
    expect(isTrustedProxy("100.64.0.9", cidrs)).toBe(true);
    expect(isTrustedProxy("100.64.0.9", DEFAULT_CIDRS)).toBe(false);
  });
});

describe("resolveClientIp", () => {
  test("ignores XFF from an untrusted (public) peer — anti-spoof", () => {
    const ip = resolveClientIp("8.8.8.8", DEFAULT_CIDRS, { xff: "1.2.3.4", xRealIp: "5.6.7.8" });
    expect(ip).toBe("8.8.8.8"); // the spoofed headers are discarded
  });
  test("takes the LAST XFF hop from a trusted proxy (proxy-appended)", () => {
    // Client sent "1.1.1.1"; the proxy appended the real peer "203.0.113.9".
    const ip = resolveClientIp("10.0.0.2", DEFAULT_CIDRS, {
      xff: "1.1.1.1, 203.0.113.9",
      xRealIp: null,
    });
    expect(ip).toBe("203.0.113.9");
  });
  test("falls back to X-Real-IP when XFF is absent but peer is trusted", () => {
    const ip = resolveClientIp("127.0.0.1", DEFAULT_CIDRS, { xff: null, xRealIp: "203.0.113.10" });
    expect(ip).toBe("203.0.113.10");
  });
  test("returns the peer when trusted but no forwarding headers present", () => {
    expect(resolveClientIp("10.0.0.2", DEFAULT_CIDRS, { xff: null, xRealIp: null })).toBe("10.0.0.2");
  });
  test("returns 'unknown' when there is no peer at all", () => {
    expect(resolveClientIp(undefined, DEFAULT_CIDRS, { xff: "1.2.3.4", xRealIp: null })).toBe("unknown");
  });
});
