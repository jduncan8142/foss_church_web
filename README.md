# FOSS Church website

Marketing site for **FOSS Church** — a non-profit providing free and at-cost
technology services and software to churches and like-minded organizations.

A single polished dark-theme landing page served by a small **Bun + Hono**
server, with a contact form that emails submissions via SMTP and keeps a durable
local log of every lead.

- **Mission** · **Services** (Tech Consulting/MSP, AVL, Web, AI) · **Products**
  (Plan AVL, ChMS) · **About** · **Contact form**
- `POST /api/contact` → validate → store (`data/leads.jsonl`) → email admin +
  auto-reply to the submitter
- `GET /healthz` → JSON health probe (used by the Docker `HEALTHCHECK`)

## Stack

| | |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.3 (runs the TypeScript directly — no build step) |
| Server | [Hono](https://hono.dev) — static serving + routing + security headers |
| Email | [nodemailer](https://nodemailer.com) over SMTP (`mail.fosschurch.com:465`) |
| Front-end | Hand-written HTML/CSS/JS (no framework, no bundler) |
| Deploy | Docker + Docker Compose on `fc1`, proxied by Nginx Proxy Manager |

```
src/         server.ts (routes) · email.ts · validate.ts · leads.ts · rateLimit.ts · config.ts · util.ts
public/      index.html · styles.css · app.js · logo/favicon svg · og.svg + og.png · manifest/robots/sitemap
scripts/     build-og.mjs  (renders og.svg -> og.png 1200x630; `bun run build:og`)
Dockerfile · docker-compose.yml · fosschurch-web.env.example
```

> The social share image `public/og.png` is generated from `public/og.svg` via
> `bun run build:og` (a build-time-only `@resvg/resvg-js` dependency). Re-run it
> after editing `og.svg`; the PNG is committed so runtime/Docker need no extra deps.

## Local development

```sh
bun install
bun run dev          # http://localhost:8080  (watch mode)
```

Without `FC_SMTP_PASSWORD` set, the server **does not send email** — it logs the
submission and still writes it to `data/leads.jsonl`. That's the intended local
default. To test real sends locally, export the SMTP vars (see below) first.

Quick contact-endpoint smoke test:

```sh
curl -s localhost:8080/healthz
curl -s -X POST localhost:8080/api/contact \
  -H 'content-type: application/json' \
  -d '{"name":"Test User","email":"test@example.com","message":"Hello there","services":["web","ai"]}'
```

## Configuration

All config is environment-driven (`src/config.ts`). Non-secret values live in
`docker-compose.yml`; **only the SMTP password** belongs in the gitignored
`fosschurch-web.env`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Listen port inside the container |
| `FC_BASE_URL` | `https://fosschurch.com` | Used in email links |
| `FC_ADMIN_EMAILS` | `jason.matthew.duncan@gmail.com` | Comma-separated recipients |
| `FC_AUTOREPLY` | `true` | Send the submitter an acknowledgement |
| `FC_SMTP_HOST` | `mail.fosschurch.com` | |
| `FC_SMTP_PORT` | `465` | Implicit TLS |
| `FC_SMTP_SECURE` | `true` | `true` for 465 |
| `FC_SMTP_USER` | `contact@fosschurch.com` | |
| `FC_SMTP_FROM` | `FOSS Church <contact@fosschurch.com>` | |
| **`FC_SMTP_PASSWORD`** | — | **Secret** — supply via `fosschurch-web.env` |
| `FC_DATA_DIR` | `./data` (`/app/data` in Docker) | Lead log location |
| `FC_RATELIMIT_MAX` / `FC_RATELIMIT_WINDOW_MS` | `5` / `600000` | Per-IP throttle on `/api/contact` |
| `FC_TRUSTED_PROXY_CIDRS` | loopback + RFC1918 | CIDRs allowed to set `X-Forwarded-For`. Must include the proxy's Docker subnet (`fc_external` = `172.10.0.0/16`, outside RFC1918) so the real client IP is used for rate-limiting/logging |
| `FC_TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile **public** site key (compose `environment`) |
| `FC_TURNSTILE_SECRET` | — | Turnstile **secret** (gitignored env file). Captcha enforces only when both this and the site key are set |
| `FC_UMAMI_SRC` | — | Umami tracking script URL, e.g. `https://analytics.fosschurch.com/script.js`. Its origin is auto-added to the CSP |
| `FC_UMAMI_WEBSITE_ID` | — | Umami website id. Snippet loads only when both this and `FC_UMAMI_SRC` are set |

## Deploy to fc1

Apps on `fc1` live as Compose stacks in `~` and join the external
`fc_external` network that Nginx Proxy Manager (`npm_app_1`) proxies through —
same pattern as the `planavl` stack.

1. **Sync the project to `fc1`** (from the repo root on your workstation):

   ```sh
   rsync -av --delete \
     --exclude node_modules --exclude data --exclude .git \
     ./ fc1:~/fosschurch-web/
   ```

2. **Add the SMTP secret** (once):

   ```sh
   ssh fc1
   cd ~/fosschurch-web
   cp fosschurch-web.env.example fosschurch-web.env
   nano fosschurch-web.env        # set FC_SMTP_PASSWORD=...
   mkdir -p data                  # lead log (owned by fcadmin, uid 1000)
   ```

3. **Build & start:**

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs -f
   ```

4. **Verify locally on fc1:**

   ```sh
   curl -s localhost:8090/healthz
   ```

5. **Expose via Nginx Proxy Manager** (web UI on `fc1:81`): add a Proxy Host

   - Domain Names: `fosschurch.com`, `www.fosschurch.com`
   - Scheme: `http` · Forward Host: `fosschurch-web` · Forward Port: `8080`
   - Block Common Exploits ✓, Websockets not required
   - SSL tab: request a Let's Encrypt cert, Force SSL + HTTP/2

   NPM reaches the container by name because both share `fc_external`.

### Updating

```sh
rsync ... ./ fc1:~/fosschurch-web/      # push changes
ssh fc1 'cd ~/fosschurch-web && docker compose up -d --build'
```

### Leads

Every submission is appended to `~/fosschurch-web/data/leads.jsonl` on `fc1`
(one JSON object per line) regardless of email delivery, so nothing is lost if
SMTP hiccups.

```sh
tail -n 5 ~/fosschurch-web/data/leads.jsonl
```

## Troubleshooting

- **Form returns 502 / emails not arriving:** check `docker compose logs`. Live
  email needs outbound SMTP egress (465/587) from `fc1` — the same egress the
  `planavl` stack uses. The lead is still saved to `data/leads.jsonl`.
- **`healthz` shows `"smtp": false`:** `FC_SMTP_PASSWORD` isn't set — the env
  file is missing or empty. The site runs but only logs submissions.
- **NPM 502 Bad Gateway:** confirm the container is `healthy`
  (`docker compose ps`) and that the Proxy Host forwards to `fosschurch-web:8080`.
