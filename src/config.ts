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
} as const;

// When no SMTP password is configured we still accept + store submissions but
// log them instead of sending (handy for local development).
export const smtpConfigured = config.smtp.pass.length > 0;
