import { describe, expect, test } from "bun:test";

import { publicCardOrigin, publicCardUrl } from "./public-card-url";

describe("public loyalty card URL", () => {
  test("uses the explicitly configured branded origin", () => {
    expect(publicCardUrl("https://api.example.com/api/loyalty", "abc_123", "https://cards.innseva.com/path", "https://app.innseva.com"))
      .toBe("https://cards.innseva.com/l/abc_123");
  });

  test("prefers a branded allowed frontend over hosting aliases", () => {
    expect(publicCardOrigin(
      "https://hotel-pms-backend.vercel.app/api/loyalty",
      undefined,
      "https://hotelpmsfrontend.netlify.app, https://app.innseva.com",
    )).toBe("https://app.innseva.com");
  });

  test("falls back to the request origin for local development", () => {
    expect(publicCardUrl("http://localhost:3000/api/loyalty", "local-token", undefined, undefined))
      .toBe("http://localhost:3000/l/local-token");
  });
});
