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

// RFC1918 / loopback / link-local / ULA — i.e. an address that can only be our
// own reverse proxy (the NPM container) rather than a real internet client.
function isPrivateAddr(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, ""); // unwrap IPv4-mapped IPv6
  if (a === "127.0.0.1" || a === "::1") return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true; // link-local
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(a)) return true; // IPv6 ULA
  return false;
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

  if (peer && isPrivateAddr(peer)) {
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
