// Cloudflare Turnstile server-side verification.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

import { config } from "./config.ts";

export async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new URLSearchParams();
    body.set("secret", config.turnstile.secret);
    body.set("response", token);
    if (ip && ip !== "unknown") body.set("remoteip", ip);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) {
      console.warn("[turnstile] verification failed:", (data["error-codes"] || []).join(", ") || "no detail");
    }
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] verify error:", (err as Error).message);
    return false;
  }
}
