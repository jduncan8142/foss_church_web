// Trusted-proxy / client-IP resolution. Extracted from server.ts so the
// security-sensitive CIDR + XFF logic is unit-testable in isolation (WEB-002).
//
// The threat model: a client can spoof X-Forwarded-For but cannot spoof the
// TCP socket peer (Bun's requestIP). So XFF is only believed when the peer is
// one of our reverse proxies; everything else is treated as a hostile client.

// IPv4 dotted-quad -> 32-bit int (null if not a valid IPv4 address).
export function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

// Is `addr` inside `cidr`? IPv4 CIDRs match numerically; for IPv6 we only
// support an exact-address match (enough for ::1).
export function inCidr(addr: string, cidr: string): boolean {
  if (cidr.includes(":")) return addr === cidr.split("/")[0];
  const [base, bitsRaw] = cidr.split("/");
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base!);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

// True when the direct socket peer is one of our trusted reverse proxies, so
// its X-Forwarded-For can be believed. Anything else is a potentially hostile
// client whose headers we ignore. `cidrs` is the trusted-proxy allowlist
// (config.trustedProxyCidrs).
export function isTrustedProxy(addr: string, cidrs: readonly string[]): boolean {
  const a = addr.replace(/^::ffff:/i, ""); // unwrap IPv4-mapped IPv6
  if (a === "::1") return true;
  return cidrs.some((c) => inCidr(a, c));
}

// Resolve the real client IP from the socket peer + X-Forwarded-For, trusting
// XFF only when the peer is a known proxy. We take the LAST hop of XFF, not the
// first: our reverse proxy (Nginx Proxy Manager) uses
// `$proxy_add_x_forwarded_for`, which APPENDS the real client IP to whatever
// the client sent — so the value the proxy added is the last entry and is the
// only trustworthy one. Taking the first hop would still be client-spoofable.
export function resolveClientIp(
  peer: string | undefined,
  cidrs: readonly string[],
  headers: { xff?: string | null; xRealIp?: string | null },
): string {
  if (peer && isTrustedProxy(peer, cidrs)) {
    const hops = headers.xff?.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops && hops.length) return hops[hops.length - 1]!;
    if (headers.xRealIp) return headers.xRealIp;
  }
  return peer || "unknown";
}
