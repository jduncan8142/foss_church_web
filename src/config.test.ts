// Tests for the WEB-006 fail-closed captcha guard. The guard is pure + fully
// input-driven so the fail-open regression (a live production server accepting
// un-CAPTCHA'd submissions when the Turnstile secret is missing) is caught here.
import { describe, expect, test } from "bun:test";
import { captchaConfigStatus } from "./config.ts";

describe("captchaConfigStatus", () => {
  test("captcha enabled => ok in any environment", () => {
    expect(captchaConfigStatus({ nodeEnv: "production", turnstileEnabled: true, allowNoCaptcha: false }).level).toBe("ok");
    expect(captchaConfigStatus({ nodeEnv: "development", turnstileEnabled: true, allowNoCaptcha: false }).level).toBe("ok");
  });

  test("production + no captcha + no opt-out => FATAL (fail-closed)", () => {
    const s = captchaConfigStatus({ nodeEnv: "production", turnstileEnabled: false, allowNoCaptcha: false });
    expect(s.level).toBe("fatal");
    expect(s.message).toContain("FC_ALLOW_NO_CAPTCHA");
  });

  test("production + no captcha + explicit opt-out => warn (boots, but loud)", () => {
    const s = captchaConfigStatus({ nodeEnv: "production", turnstileEnabled: false, allowNoCaptcha: true });
    expect(s.level).toBe("warn");
    expect(s.message).toContain("WITHOUT a captcha");
  });

  test("non-production + no captcha => warn, never fatal", () => {
    expect(captchaConfigStatus({ nodeEnv: "development", turnstileEnabled: false, allowNoCaptcha: false }).level).toBe("warn");
    expect(captchaConfigStatus({ nodeEnv: "test", turnstileEnabled: false, allowNoCaptcha: false }).level).toBe("warn");
  });

  test("the opt-out does NOT downgrade a properly-configured prod (still ok)", () => {
    expect(captchaConfigStatus({ nodeEnv: "production", turnstileEnabled: true, allowNoCaptcha: true }).level).toBe("ok");
  });
});
