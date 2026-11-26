import * as webpush from "web-push";

export type PushProviderStatus = { ready: boolean; missing: string[] };

export function webPushProviderStatus(env: Record<string, string | undefined> = process.env): PushProviderStatus {
  const keys = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"] as const;
  return { ready: keys.every((key) => Boolean(env[key])), missing: keys.filter((key) => !env[key]) };
}

export function publicVapidKey() {
  return webPushProviderStatus().ready ? process.env.WEB_PUSH_VAPID_PUBLIC_KEY! : null;
}

export type StoredPushSubscription = { endpoint: string; p256dh: string; auth: string; cardPath: string };

export async function sendWebPush(subscription: StoredPushSubscription, payload: { title: string; body: string }) {
  const status = webPushProviderStatus();
  if (!status.ready) throw new Error("Web push provider is not configured.");
  webpush.setVapidDetails(process.env.WEB_PUSH_VAPID_SUBJECT!, process.env.WEB_PUSH_VAPID_PUBLIC_KEY!, process.env.WEB_PUSH_VAPID_PRIVATE_KEY!);
  await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ ...payload, url: subscription.cardPath, tag: "innseva-loyalty-deal" }), { TTL: 60 * 60 * 24 });
}

export function isExpiredPushSubscription(error: unknown) {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
  return statusCode === 404 || statusCode === 410;
}
