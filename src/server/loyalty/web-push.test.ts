import { describe, expect, test } from "bun:test";

import { isExpiredPushSubscription, webPushProviderStatus } from "./web-push";

describe("loyalty web push", () => {
  test("reports exactly which VAPID settings are missing", () => {
    expect(webPushProviderStatus({ WEB_PUSH_VAPID_PUBLIC_KEY: "public" })).toEqual({
      ready: false,
      missing: ["WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"],
    });
  });

  test("is ready when the complete VAPID identity is present", () => {
    expect(webPushProviderStatus({ WEB_PUSH_VAPID_PUBLIC_KEY: "public", WEB_PUSH_VAPID_PRIVATE_KEY: "private", WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.com" })).toEqual({ ready: true, missing: [] });
  });

  test("recognizes subscriptions the push service has retired", () => {
    expect(isExpiredPushSubscription({ statusCode: 410 })).toBe(true);
    expect(isExpiredPushSubscription({ statusCode: 500 })).toBe(false);
  });
});
