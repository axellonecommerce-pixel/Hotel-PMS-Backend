import { describe, expect, test } from "bun:test";

import { GET, loyaltyManifest } from "./route";

describe("loyalty card manifest", () => {
  test("uses the motel brand and reopens the exact private card", () => {
    const token = "a".repeat(32);
    expect(loyaltyManifest(token, "Sun Star Inn")).toMatchObject({ name: "Sun Star Inn Rewards", short_name: "Sun Star Inn Rewards", start_url: `/l/${token}`, display: "standalone", icons: [{ src: `/l/${token}/app-icon` }] });
  });

  test("rejects malformed card tokens", async () => {
    const response = await GET(new Request("https://app.innseva.com/l/bad/manifest.webmanifest"), { params: Promise.resolve({ token: "bad" }) });
    expect(response.status).toBe(404);
  });
});
