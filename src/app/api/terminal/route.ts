import { z } from "zod";

import { propertyAccessResponse, requirePropertySession, requireSettingsSection } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { BankAccountError, bankAccountFor } from "@/server/finance/cash-sources";
import { isStripeKey, ProcessorError } from "@/server/terminal/stripe";
import { connectStripe, disconnectTerminal, listReaders, loadConnection, registerReader, settleStaleTerminalPayments, syncPayouts, TerminalError } from "@/server/terminal/terminal-service";

export const dynamic = "force-dynamic";

// Settings › Payment Terminal. Connecting is optional: without a terminal the
// PMS keeps taking keyed-in card payments and Cash & Bank deposits.

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), provider: z.literal("stripe"), secretKey: z.string().trim().min(20).max(255) }),
  z.object({ action: z.literal("disconnect") }),
  z.object({ action: z.literal("register_reader"), registrationCode: z.string().trim().min(3).max(100), label: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("settings"), depositBankAccountId: z.string().uuid() }),
  z.object({ action: z.literal("sync") }),
]);

function errorResponse(error: unknown) {
  if (error instanceof ProcessorError || error instanceof TerminalError || error instanceof BankAccountError) return Response.json({ error: error.message }, { status: 409 });
  return propertyAccessResponse(error);
}

/** Connection status (never the key) and readers; the front desk needs the readers to charge. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payments.manage");
    if (!hasProductionDatabase()) return Response.json({ connection: null, readers: [] });
    const connection = await loadConnection(productionSql(), session.propertyId);
    let readers: Awaited<ReturnType<typeof listReaders>> = [];
    let readerError: string | null = null;
    if (connection && connection.status !== "disconnected") {
      try {
        await settleStaleTerminalPayments(productionSql(), session.propertyId);
        readers = await listReaders(productionSql(), session.propertyId);
      }
      catch (error) { readerError = error instanceof Error ? error.message : "Readers could not be loaded."; }
    }
    return Response.json({ connection: connection?.status === "disconnected" ? null : connection, readers, readerError }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    requireSettingsSection(session, "Payment Terminals");
    if (!hasProductionDatabase()) return Response.json({ error: "The card terminal needs the PMS database." }, { status: 503 });
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Check the terminal details." }, { status: 400 });
    const input = parsed.data;
    const sql = productionSql();
    if (input.action === "connect") {
      if (!isStripeKey(input.secretKey)) return Response.json({ error: "Enter a Stripe secret key (sk_live_… or a restricted key rk_live_…)." }, { status: 400 });
      await connectStripe(sql, session.propertyId, input.secretKey);
      return Response.json({ connected: true });
    }
    if (input.action === "disconnect") { await disconnectTerminal(sql, session.propertyId); return Response.json({ disconnected: true }); }
    if (input.action === "register_reader") return Response.json({ reader: await registerReader(sql, session.propertyId, input.registrationCode, input.label) }, { status: 201 });
    if (input.action === "settings") {
      const account = await bankAccountFor(sql, session.propertyId, input.depositBankAccountId);
      await sql`update payment_terminal_connections set deposit_bank_account_id=${account.id}::uuid,updated_at=now() where property_id=${session.propertyId}::uuid`;
      return Response.json({ saved: true });
    }
    return Response.json(await syncPayouts(sql, session.propertyId));
  } catch (error) { return errorResponse(error); }
}
