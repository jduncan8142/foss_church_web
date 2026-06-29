// Email delivery via SMTP (nodemailer). Two messages per submission:
//   1. An admin notification to FC_ADMIN_EMAILS (Reply-To = the submitter).
//   2. An optional friendly auto-reply to the submitter.
// If SMTP isn't configured the messages are logged instead of sent.

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config, smtpConfigured } from "./config.ts";
import { escapeHtml } from "./util.ts";
import type { Lead } from "./validate.ts";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!smtpConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      // Don't let a slow/unreachable mail host hang a request indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

// Verify the SMTP connection at startup (best-effort, logged).
export async function verifyEmail(): Promise<void> {
  const t = getTransporter();
  if (!t) {
    const msg =
      "[email] SMTP not configured — submissions will be logged/stored but NOT emailed.";
    // In production this almost certainly means a missing secret; make it loud.
    if (config.nodeEnv === "production") console.error(msg + " (set FC_SMTP_PASSWORD)");
    else console.warn(msg);
    return;
  }
  try {
    await t.verify();
    console.log(`[email] SMTP ready: ${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}`);
  } catch (err) {
    console.error("[email] SMTP verify failed (will still attempt sends):", (err as Error).message);
  }
}

function row(label: string, value: string): string {
  if (!value) return "";
  return `<tr>
    <td style="padding:6px 16px 6px 0;color:#7c8aa0;font:600 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:6px 0;color:#10151f;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif">${value}</td>
  </tr>`;
}

export function adminHtml(lead: Lead): string {
  const services = lead.services.length
    ? lead.services.map((s) => escapeHtml(s)).join("<br>")
    : "<em style='color:#7c8aa0'>None selected</em>";
  return `<!doctype html><html><body style="margin:0;background:#eef1f6;padding:24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dfe4ec">
    <tr><td style="background:linear-gradient(135deg,#0f766e,#0891b2);padding:22px 28px">
      <div style="color:#ffffff;font:700 18px/1.2 -apple-system,Segoe UI,Roboto,sans-serif">New website inquiry</div>
      <div style="color:#bdeae3;font:400 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;margin-top:4px">FOSS Church &middot; fosschurch.com</div>
    </td></tr>
    <tr><td style="padding:24px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${row("Name", escapeHtml(lead.name))}
        ${row("Email", `<a href="mailto:${escapeHtml(lead.email)}" style="color:#0891b2;text-decoration:none">${escapeHtml(lead.email)}</a>`)}
        ${row("Organization", escapeHtml(lead.organization))}
        ${row("Org type", escapeHtml(lead.orgType))}
        ${row("Phone", escapeHtml(lead.phone))}
        ${row("Interested in", services)}
      </table>
      <div style="margin:18px 0 6px;color:#7c8aa0;font:600 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">Message</div>
      <div style="background:#f5f7fb;border:1px solid #e5e9f0;border-radius:10px;padding:14px 16px;color:#10151f;font:400 14px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap">${escapeHtml(lead.message)}</div>
    </td></tr>
    <tr><td style="padding:14px 28px 22px;border-top:1px solid #eef1f6;color:#9aa6b8;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
      Received ${escapeHtml(lead.receivedAt)} &middot; ${escapeHtml(lead.ip)} &middot; ref ${escapeHtml(lead.id)}
    </td></tr>
  </table></body></html>`;
}

export function adminText(lead: Lead): string {
  return [
    "New website inquiry — FOSS Church",
    "",
    `Name:         ${lead.name}`,
    `Email:        ${lead.email}`,
    lead.organization ? `Organization: ${lead.organization}` : "",
    lead.orgType ? `Org type:     ${lead.orgType}` : "",
    lead.phone ? `Phone:        ${lead.phone}` : "",
    `Interested:   ${lead.services.length ? lead.services.join(", ") : "(none selected)"}`,
    "",
    "Message:",
    lead.message,
    "",
    `Received ${lead.receivedAt} · ${lead.ip} · ref ${lead.id}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function autoReplyHtml(lead: Lead): string {
  const first = escapeHtml(lead.name.split(" ")[0] || "there");
  return `<!doctype html><html><body style="margin:0;background:#eef1f6;padding:24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dfe4ec">
    <tr><td style="background:linear-gradient(135deg,#0f766e,#0891b2);padding:26px 30px">
      <div style="color:#ffffff;font:700 20px/1.2 -apple-system,Segoe UI,Roboto,sans-serif">Thanks, ${first} 👋</div>
    </td></tr>
    <tr><td style="padding:26px 30px;color:#1c2430;font:400 15px/1.7 -apple-system,Segoe UI,Roboto,sans-serif">
      <p style="margin:0 0 14px">Thank you for reaching out to <strong>FOSS Church</strong>. We've received your request and a real person will get back to you, usually within a couple of business days.</p>
      <p style="margin:0 0 14px">Our mission is to take the good news of Jesus to all — and one way we do that is by providing free and at-cost technology to churches and like-minded non-profits. We'll work with you to find the right fit for your needs.</p>
      <p style="margin:0 0 6px">In the meantime, feel free to reply to this email with anything else you'd like us to know.</p>
      <p style="margin:18px 0 0;color:#5b6675">Grace and peace,<br><strong style="color:#0f766e">The FOSS Church Team</strong></p>
    </td></tr>
    <tr><td style="padding:16px 30px 24px;border-top:1px solid #eef1f6;color:#9aa6b8;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif">
      FOSS Church &middot; <a href="${config.baseUrl}" style="color:#0891b2;text-decoration:none">fosschurch.com</a> &middot; contact@fosschurch.com
    </td></tr>
  </table></body></html>`;
}

export function autoReplyText(lead: Lead): string {
  const first = lead.name.split(" ")[0] || "there";
  return [
    `Thanks, ${first}!`,
    "",
    "Thank you for reaching out to FOSS Church. We've received your request and a real person will get back to you, usually within a couple of business days.",
    "",
    "Our mission is to take the good news of Jesus to all — and one way we do that is by providing free and at-cost technology to churches and like-minded non-profits. We'll work with you to find the right fit for your needs.",
    "",
    "In the meantime, feel free to reply to this email with anything else you'd like us to know.",
    "",
    "Grace and peace,",
    "The FOSS Church Team",
    "fosschurch.com · contact@fosschurch.com",
  ].join("\n");
}

// Sends both messages. Throws only if the admin notification fails (the
// caller has already persisted the lead, so this surfaces real delivery errors).
export async function sendContactEmails(lead: Lead): Promise<{ sent: boolean }> {
  const t = getTransporter();

  if (!t) {
    console.log("[email] (not configured) would notify admin of lead:\n" + adminText(lead));
    return { sent: false };
  }

  await t.sendMail({
    from: config.smtp.from,
    to: config.adminEmails,
    // Structured form so nodemailer safely encodes the user-supplied display
    // name instead of us hand-building an address header from raw input.
    replyTo: { name: lead.name, address: lead.email },
    subject: `New inquiry from ${lead.name}${lead.organization ? ` (${lead.organization})` : ""}`,
    text: adminText(lead),
    html: adminHtml(lead),
  });

  if (config.autoReply) {
    try {
      await t.sendMail({
        from: config.smtp.from,
        to: { name: lead.name, address: lead.email },
        subject: "We received your request — FOSS Church",
        text: autoReplyText(lead),
        html: autoReplyHtml(lead),
      });
    } catch (err) {
      // Auto-reply is best-effort; the lead is already captured + admin notified.
      console.error("[email] auto-reply failed:", (err as Error).message);
    }
  }

  return { sent: true };
}
