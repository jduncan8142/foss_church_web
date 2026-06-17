// FOSS Church marketing site — Bun + Hono.
//   GET  /            static landing page (public/)
//   GET  /healthz     liveness/readiness probe
//   POST /api/contact contact-form handler (validate -> store -> email)

import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { config, smtpConfigured } from "./config.ts";
import { validateAndNormalize } from "./validate.ts";
import { storeLead } from "./leads.ts";
import { sendContactEmails, verifyEmail } from "./email.ts";
import { rateLimit } from "./rateLimit.ts";

const app = new Hono();

app.use("*", logger());

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginEmbedderPolicy: false,
  }),
);

app.get("/healthz", (c) =>
  c.json({ status: "ok", smtp: smtpConfigured, time: new Date().toISOString() }),
);

// IPv4 dotted-quad -> 32-bit int (null if not IPv4).
function ipv4ToInt(ip: string): number | null {
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
function inCidr(addr: string, cidr: string): boolean {
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
// client whose headers we ignore.
function isTrustedProxy(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, ""); // unwrap IPv4-mapped IPv6
  if (a === "::1") return true;
  return config.trustedProxyCidrs.some((c) => inCidr(a, c));
}

// Rate-limit key. The socket peer (from Bun's requestIP) cannot be spoofed by
// the client; X-Forwarded-For can. So we only trust XFF when the request
// actually arrived through our proxy (a private-network peer).
//
// We also take the LAST hop of XFF, not the first: our single reverse proxy
// (Nginx Proxy Manager) uses `$proxy_add_x_forwarded_for`, which APPENDS the
// real client IP to whatever the client sent — so the value the proxy added is
// the last one and is the only trustworthy entry. Taking the first hop would
// still be client-spoofable.
function clientIp(c: Context): string {
  const server = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined;
  const peer = server?.requestIP?.(c.req.raw)?.address;

  if (peer && isTrustedProxy(peer)) {
    const xff = c.req.header("x-forwarded-for");
    const hops = xff?.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops && hops.length) return hops[hops.length - 1]!;
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return peer || "unknown";
}

app.post("/api/contact", async (c) => {
  const now = Date.now();
  const ip = clientIp(c);

  if (!rateLimit(ip, config.rateLimit.max, config.rateLimit.windowMs, now)) {
    return c.json({ ok: false, error: "Too many requests. Please try again in a little while." }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: "Invalid request format." }, 400);
  }

  // Honeypot: bots fill the hidden "website" field. Pretend success.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return c.json({ ok: true });
  }

  const result = validateAndNormalize(body, {
    ip,
    userAgent: c.req.header("user-agent") ?? "",
    id: crypto.randomUUID().slice(0, 8),
    now: new Date(now).toISOString(),
  });

  if (!result.ok || !result.lead) {
    return c.json({ ok: false, error: result.errors.join(" ") }, 422);
  }

  const lead = result.lead;

  // Persist first so a submission is never lost, even if email delivery fails.
  let persisted = false;
  try {
    await storeLead(lead);
    persisted = true;
  } catch (err) {
    console.error("[leads] failed to persist:", (err as Error).message);
  }

  try {
    await sendContactEmails(lead);
  } catch (err) {
    console.error("[contact] email delivery failed:", (err as Error).message);
    if (persisted) {
      // The lead is safely stored; surface a soft failure honestly.
      return c.json(
        {
          ok: false,
          error:
            "We saved your message but hit a snag emailing it. Please email contact@fosschurch.com directly if you don't hear back.",
        },
        502,
      );
    }
    // Neither stored nor emailed — don't claim we saved it.
    return c.json(
      {
        ok: false,
        error:
          "We couldn't process your message right now. Please email contact@fosschurch.com directly.",
      },
      500,
    );
  }

  // Email went out (or was logged) but the durable copy failed — alert ops.
  if (!persisted) {
    console.error(`[contact] WARNING: lead ${lead.id} was emailed/logged but NOT persisted to disk.`);
  }

  return c.json({ ok: true });
});

// Static assets (cached lightly; index.html served for "/").
app.use("/*", serveStatic({ root: "./public" }));

// SPA-ish fallback: unknown GET paths render the landing page; everything else 404s.
app.notFound(async (c) => {
  if (c.req.method === "GET" && !c.req.path.startsWith("/api")) {
    const file = Bun.file("./public/index.html");
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }
  return c.json({ ok: false, error: "Not found" }, 404);
});

// Fire-and-forget: a slow/unreachable SMTP host must never block the server
// from binding its port (which would fail the container healthcheck).
void verifyEmail();

console.log(`[fosschurch-web] listening on http://0.0.0.0:${config.port} (env: ${config.nodeEnv})`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Generous body limit isn't needed; cap request size defensively.
  maxRequestBodySize: 256 * 1024,
};
