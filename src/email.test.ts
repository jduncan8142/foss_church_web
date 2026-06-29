// Tests for the contact-email body builders (WEB-002 coverage extension).
// The admin notification + auto-reply render attacker-controlled lead fields
// (name/email/org/phone/message/...) into HTML, so every field must be
// HTML-escaped — these pin that XSS-safety as a regression guard. The text
// variants intentionally carry the raw values (plain-text email, no markup).
import { describe, expect, test } from "bun:test";
import { adminHtml, adminText, autoReplyHtml, autoReplyText } from "./email.ts";
import type { Lead } from "./validate.ts";

function lead(extra: Partial<Lead> = {}): Lead {
  return {
    id: "abcd1234",
    receivedAt: "2026-06-29T00:00:00.000Z",
    name: "Jane Smith",
    email: "jane@example.com",
    organization: "Grace Church",
    orgType: "Church",
    phone: "555-1234",
    services: ["ChMS Software", "AVL Consulting"],
    message: "We are looking for a church management system.",
    ip: "203.0.113.5",
    userAgent: "Mozilla/5.0 (test-agent)",
    ...extra,
  };
}

describe("adminHtml — XSS escaping", () => {
  test("neutralizes a script payload in the name", () => {
    const html = adminHtml(lead({ name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("escapes every attacker-controlled field", () => {
    // A distinct marker per field so a leak points at the offending field.
    const html = adminHtml(
      lead({
        name: "<x>NAME</x>",
        email: "<x>EMAIL</x>",
        organization: "<x>ORG</x>",
        orgType: "<x>ORGTYPE</x>",
        phone: "<x>PHONE</x>",
        message: "<x>MESSAGE</x>",
        services: ["<x>SVC</x>"],
        receivedAt: "<x>RECV</x>",
        ip: "<x>IP</x>",
        id: "<x>ID</x>",
      }),
    );
    for (const marker of [
      "NAME",
      "EMAIL",
      "ORG",
      "ORGTYPE",
      "PHONE",
      "MESSAGE",
      "SVC",
      "RECV",
      "IP",
      "ID",
    ]) {
      expect(html).toContain(`&lt;x&gt;${marker}&lt;/x&gt;`);
      expect(html).not.toContain(`<x>${marker}</x>`);
    }
  });

  test("prevents mailto: href attribute breakout via the email field", () => {
    const html = adminHtml(lead({ email: `"><img src=x onerror=alert(1)>` }));
    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  test("renders a placeholder when no services are selected", () => {
    const html = adminHtml(lead({ services: [] }));
    expect(html).toContain("None selected");
  });
});

describe("autoReplyHtml — XSS escaping + greeting", () => {
  test("escapes the first name in the greeting", () => {
    const html = autoReplyHtml(lead({ name: "<b>Bob</b> Jones" }));
    expect(html).not.toContain("<b>Bob</b>");
    expect(html).toContain("&lt;b&gt;Bob&lt;/b&gt;");
  });

  test("falls back to 'there' when the name is empty", () => {
    expect(autoReplyHtml(lead({ name: "" }))).toContain("Thanks, there");
  });
});

describe("text bodies — raw values, correct structure", () => {
  test("adminText includes the raw field values and omits empty optional rows", () => {
    const text = adminText(lead({ phone: "", organization: "" }));
    expect(text).toContain("Name:         Jane Smith");
    expect(text).toContain("Email:        jane@example.com");
    expect(text).not.toContain("Phone:");
    expect(text).not.toContain("Organization:");
  });

  test("adminText shows the no-services fallback", () => {
    expect(adminText(lead({ services: [] }))).toContain("(none selected)");
  });

  test("autoReplyText greets by first name with the 'there' fallback", () => {
    expect(autoReplyText(lead({ name: "Jane Smith" }))).toContain("Thanks, Jane!");
    expect(autoReplyText(lead({ name: "" }))).toContain("Thanks, there!");
  });
});
