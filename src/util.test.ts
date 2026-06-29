// Tests for the HTML-escaping + input-cleaning utilities (WEB-002 coverage extension).
// escapeHtml is the XSS-defense backbone for the rendered contact emails (email.ts);
// clean/cleanMultiline are the input normalizers used by validate.ts.
import { describe, expect, test } from "bun:test";
import { escapeHtml, clean, cleanMultiline } from "./util.ts";

describe("escapeHtml", () => {
  test("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  test("neutralizes a script-tag XSS payload", () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("neutralizes an attribute-breakout payload (quotes escaped)", () => {
    // The mailto: href in adminHtml interpolates an escaped value into a
    // double-quoted attribute; a raw double-quote must not be able to close it.
    const out = escapeHtml(`" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).toContain("&quot;");
  });

  test("escapes & first so existing entities are not double-mangled into broken markup", () => {
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  test("coerces nullish/non-string input to an empty or stringified value", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("clean", () => {
  test("collapses internal whitespace and trims", () => {
    expect(clean("  hello   world \t\n ", 100)).toBe("hello world");
  });

  test("clamps to the maximum length", () => {
    expect(clean("abcdefgh", 3)).toBe("abc");
  });

  test("coerces nullish input to an empty string", () => {
    expect(clean(null, 10)).toBe("");
    expect(clean(undefined, 10)).toBe("");
  });
});

describe("cleanMultiline", () => {
  test("preserves single newlines but collapses 3+ into a blank-line gap", () => {
    expect(cleanMultiline("line1\n\n\n\nline2", 100)).toBe("line1\n\nline2");
  });

  test("normalizes CRLF to LF", () => {
    expect(cleanMultiline("a\r\nb", 100)).toBe("a\nb");
  });

  test("collapses runs of spaces/tabs but keeps line breaks", () => {
    expect(cleanMultiline("a    b\nc\t\td", 100)).toBe("a b\nc d");
  });

  test("clamps to the maximum length", () => {
    expect(cleanMultiline("abcdefgh", 4)).toBe("abcd");
  });
});
