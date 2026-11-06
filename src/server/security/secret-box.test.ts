import { expect, test } from "bun:test";

import { openSecret, sealSecret } from "./secret-box";

test("secrets round-trip and tampering is detected", () => {
  process.env.PMS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const sealed = sealSecret("rk_live_example");
  expect(sealed).not.toContain("rk_live_example");
  expect(openSecret(sealed)).toBe("rk_live_example");
  const parts = sealed.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  expect(() => openSecret(parts.join(":"))).toThrow();
});
