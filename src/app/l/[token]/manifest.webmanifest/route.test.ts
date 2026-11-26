import { describe, expect, test } from "bun:test";

import { GET } from "./route";

describe("loyalty card manifest", () => {
  test("reopens the exact private loyalty card as an installed web app", async () => {
    const token = "a".repeat(32);
    const response = await GET(new Request(`https://app.innseva.com/l/${token}/manifest.webmanifest`), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ start_url: `/l/${token}`, display: "standalone" });
  });

  test("rejects malformed card tokens", async () => {
    const response = await GET(new Request("https://app.innseva.com/l/bad/manifest.webmanifest"), { params: Promise.resolve({ token: "bad" }) });
    expect(response.status).toBe(404);
  });
});
