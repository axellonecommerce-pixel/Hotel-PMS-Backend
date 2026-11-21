import { z } from "zod";

import { propertyAccessResponse, requirePropertySession, requireSettingsSection } from "@/server/auth/property-session";
import { withRequestContext } from "@/server/db/request-context";
import { sendEmail, sendSms } from "@/server/loyalty/reminders";

const testSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("sms"), destination: z.string().trim().min(7).max(40) }),
  z.object({ channel: z.literal("email"), destination: z.string().email().max(320) }),
]);

function httpsUrl(value: string | undefined) {
  try { return Boolean(value && new URL(value).protocol === "https:"); } catch { return false; }
}

function status() {
  return {
    appleWallet: { ready: httpsUrl(process.env.APPLE_WALLET_PASS_URL), missing: httpsUrl(process.env.APPLE_WALLET_PASS_URL) ? [] : ["APPLE_WALLET_PASS_URL"] },
    googleWallet: { ready: httpsUrl(process.env.GOOGLE_WALLET_SAVE_URL), missing: httpsUrl(process.env.GOOGLE_WALLET_SAVE_URL) ? [] : ["GOOGLE_WALLET_SAVE_URL"] },
    sms: { ready: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER), missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"].filter((key) => !process.env[key]) },
    email: { ready: Boolean(process.env.RESEND_API_KEY && process.env.LOYALTY_EMAIL_FROM), missing: ["RESEND_API_KEY", "LOYALTY_EMAIL_FROM"].filter((key) => !process.env[key]) },
  };
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage"); requireSettingsSection(session, "Loyalty & Offers");
    return Response.json({ providers: status() });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage"); requireSettingsSection(session, "Loyalty & Offers");
    if (session.role !== "owner" && session.role !== "manager") return Response.json({ error: "Only an owner or manager can send a provider test." }, { status: 403 });
    const parsed = testSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Enter a valid test destination." }, { status: 400 });
    if (parsed.data.channel === "sms") await sendSms(parsed.data.destination, "InnSeva loyalty test: SMS delivery is configured correctly.");
    else await sendEmail(parsed.data.destination, "InnSeva loyalty delivery test", "InnSeva loyalty test: email delivery is configured correctly.");
    return Response.json({ sent: true, providers: status() });
  } catch (error) {
    if (error instanceof Error && /provider|configured|returned/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
