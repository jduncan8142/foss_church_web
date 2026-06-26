// Validation + normalization for contact-form submissions. The service catalog
// here is the source of truth; the front-end checkbox values must match these
// keys (see public/index.html).

import { clean, cleanMultiline } from "./util.ts";

export const SERVICES: Record<string, string> = {
  msp: "Technology Consulting & MSP",
  avl: "AVL Consulting, Support & Training",
  web: "Web Development, Hosting & Auditing",
  ai: "AI Consulting Services",
  planavl: "Plan AVL",
  chms: "ChMS Software",
  unsure: "Not sure yet — help me figure it out",
};

export const ORG_TYPES: Record<string, string> = {
  church: "Church",
  ministry: "Ministry / Para-church",
  nonprofit: "Non-profit",
  school: "School / Education",
  other: "Other",
};

export interface Lead {
  id: string;
  receivedAt: string;
  name: string;
  email: string;
  organization: string;
  orgType: string; // human label
  phone: string;
  services: string[]; // human labels
  message: string;
  ip: string;
  userAgent: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  lead?: Lead;
}

// Honeypot: a hidden "website" field no human fills. Bots that auto-complete
// every field trip it. Returns true when the field carries a non-empty value,
// so the caller can silently pretend success without doing real work.
export function isHoneypotTripped(body: Record<string, unknown>): boolean {
  return typeof body.website === "string" && body.website.trim() !== "";
}

// Pragmatic email check — not RFC-perfect, just rejects obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateAndNormalize(
  raw: unknown,
  ctx: { ip: string; userAgent: string; id: string; now: string },
): ValidationResult {
  const errors: string[] = [];
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const organization = clean(body.organization, 160);
  const phone = clean(body.phone, 40);
  const message = cleanMultiline(body.message, 5000);

  if (name.length < 2) errors.push("Please enter your name.");
  if (!EMAIL_RE.test(email)) errors.push("Please enter a valid email address.");
  if (message.length < 5) errors.push("Please include a short message about what you need.");

  const orgTypeKey = clean(body.orgType, 40).toLowerCase();
  const orgType = ORG_TYPES[orgTypeKey] ?? "";

  const rawServices = Array.isArray(body.services) ? body.services : [];
  const services = rawServices
    .map((s) => clean(s, 40).toLowerCase())
    .filter((s, i, arr) => SERVICES[s] && arr.indexOf(s) === i)
    .map((s) => SERVICES[s] as string);

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    lead: {
      id: ctx.id,
      receivedAt: ctx.now,
      name,
      email,
      organization,
      orgType,
      phone,
      services,
      message,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  };
}
