// Escape a string for safe interpolation into HTML (emails, etc.).
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Collapse/trim whitespace and clamp to a maximum length.
export function clean(input: unknown, max: number): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Same as clean() but preserves newlines (for multi-line message bodies).
export function cleanMultiline(input: unknown, max: number): string {
  return String(input ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
