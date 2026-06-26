// FOSS Church marketing site — Bun + Hono.
//   GET  /            static landing page (public/)
//   GET  /healthz     liveness/readiness probe
//   POST /api/contact contact-form handler (validate -> store -> email)

import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { config, turnstileEnabled, umamiEnabled, captchaConfigStatus } from "./config.ts";
import { validateAndNormalize, isHoneypotTripped } from "./validate.ts";
import { storeLead } from "./leads.ts";
import { sendContactEmails, verifyEmail } from "./email.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { rateLimit } from "./rateLimit.ts";
import { resolveClientIp } from "./ip.ts";

// WEB-006: refuse to boot fail-open. In production a missing Turnstile key is
// fatal (throws here, before the port binds) unless FC_ALLOW_NO_CAPTCHA is
// explicitly set; otherwise we'd silently accept un-CAPTCHA'd submissions.
const captchaStatus = captchaConfigStatus({
  nodeEnv: config.nodeEnv,
  turnstileEnabled,
  allowNoCaptcha: config.allowNoCaptcha,
});
if (captchaStatus.level === "fatal") {
  console.error("[config] FATAL:", captchaStatus.message);
  throw new Error(captchaStatus.message);
} else if (captchaStatus.level === "warn") {
  console.warn("[config] WARNING:", captchaStatus.message);
}

const app = new Hono();

// Allow the configured Umami analytics origin (if any) in the CSP.
let umamiOrigin: string | null = null;
try {
  if (config.umami.src) umamiOrigin = new URL(config.umami.src).origin;
} catch {
  console.error("[config] FC_UMAMI_SRC is not a valid URL:", config.umami.src);
}
const umamiCsp = umamiOrigin ? [umamiOrigin] : [];

app.use("*", logger());

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com", ...umamiCsp],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com", ...umamiCsp],
      frameSrc: ["https://challenges.cloudflare.com"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginEmbedderPolicy: false,
  }),
);

// Liveness/readiness probe. Deliberately minimal for anonymous callers
// (WEB-006): it previously advertised smtp + captcha flags, which signalled to
// anyone exactly when the captcha was failing open. The container healthcheck
// only needs HTTP 200.
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Public, non-secret config for the front-end. Exposes the Turnstile site key
// (only when the captcha is fully configured) and the Umami snippet details.
app.get("/api/config", (c) =>
  c.json({
    turnstileSiteKey: turnstileEnabled ? config.turnstile.siteKey : null,
    umami: umamiEnabled ? { src: config.umami.src, websiteId: config.umami.websiteId } : null,
  }),
);

// Resolve the request's client IP via the testable ip.ts helpers (the
// trusted-proxy / XFF logic lives there; see WEB-002). The socket peer (from
// Bun's requestIP) cannot be spoofed by the client; X-Forwarded-For can — so
// XFF is only believed when the peer is one of our trusted proxies.
function clientIp(c: Context): string {
  const server = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined;
  const peer = server?.requestIP?.(c.req.raw)?.address;
  return resolveClientIp(peer, config.trustedProxyCidrs, {
    xff: c.req.header("x-forwarded-for"),
    xRealIp: c.req.header("x-real-ip"),
  });
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
  if (isHoneypotTripped(body)) {
    return c.json({ ok: true });
  }

  // Captcha (when configured): verify the Turnstile token before any real work.
  if (turnstileEnabled) {
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    if (!(await verifyTurnstile(token, ip))) {
      return c.json({ ok: false, error: "Captcha verification failed. Please try again." }, 403);
    }
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
