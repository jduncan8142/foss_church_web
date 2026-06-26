// Tests for contact-form validation/normalization + the honeypot (WEB-002).
import { describe, expect, test } from "bun:test";
import { validateAndNormalize, isHoneypotTripped } from "./validate.ts";

const CTX = { ip: "203.0.113.5", userAgent: "test-agent", id: "abcd1234", now: "2026-06-26T00:00:00.000Z" };

function good(extra: Record<string, unknown> = {}) {
  return {
    name: "Jane Smith",
    email: "Jane@Example.COM",
    organization: "Grace Church",
    orgType: "church",
    phone: "555-1234",
    services: ["chms", "avl"],
    message: "We are looking for a church management system.",
    ...extra,
  };
}

describe("validateAndNormalize — happy path", () => {
  test("accepts a complete submission and normalizes it", () => {
    const r = validateAndNormalize(good(), CTX);
    expect(r.ok).toBe(true);
    expect(r.lead).toBeDefined();
    expect(r.lead!.email).toBe("jane@example.com"); // lowercased
    expect(r.lead!.orgType).toBe("Church"); // mapped to human label
    expect(r.lead!.services).toEqual(["ChMS Software", "AVL Consulting, Support & Training"]);
    expect(r.lead!.id).toBe(CTX.id);
    expect(r.lead!.ip).toBe(CTX.ip);
    expect(r.lead!.receivedAt).toBe(CTX.now);
  });
});

describe("validateAndNormalize — rejections", () => {
  test("missing name", () => {
    const r = validateAndNormalize(good({ name: "" }), CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("name");
  });
  test("invalid email", () => {
    const r = validateAndNormalize(good({ email: "not-an-email" }), CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("email");
  });
  test("too-short message", () => {
    const r = validateAndNormalize(good({ message: "hi" }), CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("message");
  });
  test("non-object body yields all-field errors, no lead", () => {
    const r = validateAndNormalize(null, CTX);
    expect(r.ok).toBe(false);
    expect(r.lead).toBeUndefined();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("validateAndNormalize — normalization details", () => {
  test("unknown orgType maps to empty label, not the raw key", () => {
    const r = validateAndNormalize(good({ orgType: "cult" }), CTX);
    expect(r.ok).toBe(true);
    expect(r.lead!.orgType).toBe("");
  });
  test("unknown + duplicate services are dropped/deduped", () => {
    const r = validateAndNormalize(good({ services: ["chms", "chms", "bogus", "web"] }), CTX);
    expect(r.lead!.services).toEqual(["ChMS Software", "Web Development, Hosting & Auditing"]);
  });
  test("non-array services is treated as none", () => {
    const r = validateAndNormalize(good({ services: "chms" }), CTX);
    expect(r.lead!.services).toEqual([]);
  });
  test("over-long fields are clamped", () => {
    const r = validateAndNormalize(good({ name: "x".repeat(500) }), CTX);
    expect(r.lead!.name.length).toBe(120);
  });
});

describe("isHoneypotTripped", () => {
  test("trips when the hidden website field is filled", () => {
    expect(isHoneypotTripped({ website: "http://spam.example" })).toBe(true);
    expect(isHoneypotTripped({ website: "   x   " })).toBe(true);
  });
  test("does not trip for humans (empty / whitespace / absent / non-string)", () => {
    expect(isHoneypotTripped({ website: "" })).toBe(false);
    expect(isHoneypotTripped({ website: "   " })).toBe(false);
    expect(isHoneypotTripped({})).toBe(false);
    expect(isHoneypotTripped({ website: 42 })).toBe(false);
  });
});
