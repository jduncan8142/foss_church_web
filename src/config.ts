// Central configuration, all sourced from environment variables so the same
// image runs locally (no secrets -> emails are logged, not sent) and on fc1
// (secrets supplied via a gitignored fosschurch-web.env).

const env = process.env;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse a positive integer, falling back when the value is blank/garbage. Guards
// against a blank env line silently becoming 0 (e.g. rate-limit max 0 would 429
// every request) or NaN (which breaks the listener / SMTP port).
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like num() but allows an explicit 0 (used by FC_LEAD_RETENTION_DAYS, where 0
// means "retain indefinitely / pruning disabled"). Blank/garbage -> fallback.
function numNonNeg(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  port: num(env.PORT, 8080),
  nodeEnv: env.NODE_ENV ?? "production",
  // Public base URL — used in canonical/OG tags and email links.
  baseUrl: (env.FC_BASE_URL ?? "https://fosschurch.com").replace(/\/+$/, ""),

  smtp: {
    host: env.FC_SMTP_HOST ?? "mail.fosschurch.com",
    port: num(env.FC_SMTP_PORT, 465),
    secure: bool(env.FC_SMTP_SECURE, true), // true for 465 (implicit TLS)
    user: env.FC_SMTP_USER ?? "contact@fosschurch.com",
    pass: env.FC_SMTP_PASSWORD ?? "",
    from: env.FC_SMTP_FROM ?? "FOSS Church <contact@fosschurch.com>",
  },

  // Where contact-form submissions are delivered.
  adminEmails: list(env.FC_ADMIN_EMAILS).length
    ? list(env.FC_ADMIN_EMAILS)
    : ["jason.matthew.duncan@gmail.com"],

  // Send the submitter a friendly acknowledgement.
  autoReply: bool(env.FC_AUTOREPLY, true),

  // Durable lead log (bind-mounted on fc1). The server never serves this dir.
  dataDir: env.FC_DATA_DIR ?? "./data",

  // Lead-log retention (WEB-004). Contact submissions hold PII (name, email,
  // phone, IP, user-agent); we keep them only as long as needed to follow up.
  // Entries older than this many days are pruned from leads.jsonl at startup
  // and daily thereafter. Default 540 (~18 months, mid-range of the OPS-G
  // 12–24-month window for Web leads). Set FC_LEAD_RETENTION_DAYS=0 to retain
  // indefinitely (pruning disabled).
  leadRetentionDays: numNonNeg(env.FC_LEAD_RETENTION_DAYS, 540),

  // Per-IP rate limit for the contact endpoint.
  rateLimit: {
    max: num(env.FC_RATELIMIT_MAX, 5),
    windowMs: num(env.FC_RATELIMIT_WINDOW_MS, 10 * 60 * 1000),
  },

  // CIDRs whose requests may set X-Forwarded-For (i.e. our reverse proxy).
  // Defaults cover loopback + RFC1918; the fc_external Docker subnet falls
  // OUTSIDE RFC1918, so it's supplied via docker-compose.yml.
  trustedProxyCidrs: list(env.FC_TRUSTED_PROXY_CIDRS).length
    ? list(env.FC_TRUSTED_PROXY_CIDRS)
    : ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],

  // Cloudflare Turnstile. siteKey is public (sent to the browser); secret stays
  // server-side. Both must be set for the captcha to activate (see
  // turnstileEnabled) — otherwise the form falls back to honeypot + rate limit.
  turnstile: {
    siteKey: env.FC_TURNSTILE_SITE_KEY ?? "",
    secret: env.FC_TURNSTILE_SECRET ?? "",
  },

  // Umami analytics (self-hosted). Both public; the tracking snippet loads only
  // when both are set (see umamiEnabled). The script URL's origin is added to
  // the CSP automatically in server.ts.
  umami: {
    src: env.FC_UMAMI_SRC ?? "", // e.g. https://analytics.fosschurch.com/script.js
    websiteId: env.FC_UMAMI_WEBSITE_ID ?? "",
  },
} as const;

// Captcha is enforced only when BOTH keys are present, so we never require a
// token the browser can't produce (or render a widget the server won't check).
export const turnstileEnabled =
  config.turnstile.siteKey.length > 0 && config.turnstile.secret.length > 0;

// Analytics snippet loads only when both the script URL and website id are set.
export const umamiEnabled = config.umami.src.length > 0 && config.umami.websiteId.length > 0;

// When no SMTP password is configured we still accept + store submissions but
// log them instead of sending (handy for local development).
export const smtpConfigured = config.smtp.pass.length > 0;
