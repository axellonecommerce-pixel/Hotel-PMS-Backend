import type { Sql, TransactionSql } from "postgres";

import { logReservationActivity, money } from "@/server/activity/reservation-activity";
import { bankAccountFor } from "@/server/finance/cash-sources";
import { DepositError, settleDeposit } from "@/server/finance/card-settlements";
import { postPaymentLedger } from "@/server/finance/payment-ledger";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { openSecret, sealSecret } from "@/server/security/secret-box";
import { isLiveKey, ProcessorError, stripeList, stripeRequest, type StripeBalanceTransaction, type StripePaymentIntent, type StripeReader } from "@/server/terminal/stripe";

type Tx = TransactionSql<Record<string, never>>;
type Db = Sql | Tx;

// Card terminal (Stripe Terminal, server-driven readers). Everything here is
// optional: with no connection the PMS keeps working with keyed-in card
// payments and Cash & Bank deposits. Other processors can be added beside
// Stripe by implementing the same steps (connect, readers, charge, refund,
// payouts).

export type TerminalConnection = {
  id: string; provider: "stripe"; status: "connected" | "disconnected" | "error"; accountName: string | null; livemode: boolean;
  locationId: string | null; depositBankAccountId: string | null; lastPayoutSyncAt: string | null; lastError: string | null;
};

export class TerminalError extends Error {}

export async function loadConnection(db: Db, propertyId: string): Promise<TerminalConnection | null> {
  const [row] = await db<TerminalConnection[]>`
    select id, provider, status, account_name as "accountName", livemode, location_id as "locationId",
      deposit_bank_account_id as "depositBankAccountId", last_payout_sync_at as "lastPayoutSyncAt", last_error as "lastError"
    from payment_terminal_connections where property_id=${propertyId}::uuid
  `;
  return row ?? null;
}

/** The connected terminal and its key, or null when none is connected. */
export async function activeTerminal(db: Db, propertyId: string) {
  const connection = await loadConnection(db, propertyId);
  if (!connection || connection.status === "disconnected") return null;
  const [secret] = await db<Array<{ ciphertext: string }>>`select ciphertext from payment_terminal_secrets where connection_id=${connection.id}::uuid`;
  if (!secret) return null;
  return { connection, key: openSecret(secret.ciphertext) };
}

async function requireTerminal(db: Db, propertyId: string) {
  const terminal = await activeTerminal(db, propertyId);
  if (!terminal) throw new TerminalError("No card terminal is connected. Connect one in Settings › Payment Terminal, or take the payment by entering it.");
  return terminal;
}

/** Checks the key, finds or creates the motel's Terminal location, and saves the (encrypted) key. */
export async function connectStripe(sql: Sql, propertyId: string, secretKey: string) {
  const key = secretKey.trim();
  // Proves the key can use Terminal and read payouts before anything is saved.
  await stripeRequest(key, "GET", "/v1/terminal/readers", { limit: 1 });
  await stripeRequest(key, "GET", "/v1/payouts", { limit: 1 });
  const [property] = await sql<Array<{ name: string; addressLine1: string; city: string; region: string; postalCode: string; countryCode: string }>>`
    select name, address_line_1 as "addressLine1", city, region, postal_code as "postalCode", coalesce(country_code,'US') as "countryCode" from properties where id=${propertyId}::uuid
  `;
  const locations = await stripeList<{ id: string; display_name: string }>(key, "/v1/terminal/locations", {}, 100);
  const location = locations.find((item) => item.display_name === property.name) ?? locations[0]
    ?? await stripeRequest<{ id: string; display_name: string }>(key, "POST", "/v1/terminal/locations", {
      display_name: property.name,
      address: { line1: property.addressLine1, city: property.city, state: property.region, postal_code: property.postalCode, country: property.countryCode || "US" },
    }, `location-${propertyId}`);
  let accountName: string | null = null;
  try {
    const account = await stripeRequest<{ settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } }>(key, "GET", "/v1/account");
    accountName = account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null;
  } catch {
    // A restricted key may not read the account; the connection still works.
  }
  await sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ id: string }>>`
      insert into payment_terminal_connections (property_id,provider,status,account_name,livemode,location_id,last_error)
      values (${propertyId}::uuid,'stripe','connected',${accountName ?? location.display_name},${isLiveKey(key)},${location.id},null)
      on conflict (property_id) do update set provider='stripe',status='connected',account_name=excluded.account_name,livemode=excluded.livemode,location_id=excluded.location_id,last_error=null,updated_at=now()
      returning id
    `;
    await tx`
      insert into payment_terminal_secrets (connection_id,ciphertext) values (${connection.id}::uuid,${sealSecret(key)})
      on conflict (connection_id) do update set ciphertext=excluded.ciphertext,updated_at=now()
    `;
  });
}

export async function disconnectTerminal(sql: Sql, propertyId: string) {
  await sql.begin(async (tx) => {
    const connection = await loadConnection(tx, propertyId);
    if (!connection) return;
    await tx`delete from payment_terminal_secrets where connection_id=${connection.id}::uuid`;
    await tx`update payment_terminal_connections set status='disconnected',updated_at=now() where id=${connection.id}::uuid`;
  });
}

export async function listReaders(db: Db, propertyId: string) {
  const terminal = await activeTerminal(db, propertyId);
  if (!terminal) return [];
  const readers = await stripeList<StripeReader>(terminal.key, "/v1/terminal/readers", {}, 200);
  return readers.map((reader) => ({ id: reader.id, label: reader.label ?? reader.device_type, deviceType: reader.device_type, status: reader.status ?? "offline", simulated: reader.device_type.startsWith("simulated") }));
}

export async function registerReader(db: Db, propertyId: string, registrationCode: string, label: string) {
  const terminal = await requireTerminal(db, propertyId);
  const reader = await stripeRequest<StripeReader>(terminal.key, "POST", "/v1/terminal/readers", { registration_code: registrationCode.trim(), label: label.trim(), location: terminal.connection.locationId ?? undefined });
  return { id: reader.id, label: reader.label ?? reader.device_type };
}

/** Sends a charge to the card reader. The payment posts when the card is approved (refreshTerminalPayment). */
export async function startTerminalPayment(tx: Tx, input: { propertyId: string; authUserId: string; reservationId: string; folioId: string; amountCents: number; readerId: string; readerLabel?: string; confirmationNumber: string }) {
  const terminal = await requireTerminal(tx, input.propertyId);
  const [record] = await tx<Array<{ id: string }>>`select gen_random_uuid() as id`;
  const intent = await stripeRequest<StripePaymentIntent>(terminal.key, "POST", "/v1/payment_intents", {
    amount: input.amountCents, currency: "usd", payment_method_types: ["card_present"], capture_method: "automatic",
    description: `Folio payment · ${input.confirmationNumber}`,
    metadata: { pms_property_id: input.propertyId, pms_reservation_id: input.reservationId, pms_folio_id: input.folioId, pms_terminal_payment_id: record.id },
  }, `pi-${record.id}`);
  try {
    await stripeRequest(terminal.key, "POST", `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/process_payment_intent`, { payment_intent: intent.id });
  } catch (error) {
    await stripeRequest(terminal.key, "POST", `/v1/payment_intents/${intent.id}/cancel`).catch(() => undefined);
    throw error;
  }
  await tx`
    insert into terminal_payments (id,property_id,connection_id,reservation_id,folio_id,reader_id,reader_label,provider_payment_id,amount_cents,status,created_by_auth_user_id)
    values (${record.id}::uuid,${input.propertyId}::uuid,${terminal.connection.id}::uuid,${input.reservationId}::uuid,${input.folioId}::uuid,${input.readerId},${input.readerLabel ?? null},${intent.id},${input.amountCents},'processing',${/^[0-9a-f-]{36}$/i.test(input.authUserId) ? input.authUserId : null}::uuid)
  `;
  return { id: record.id, status: "processing" as const, livemode: terminal.connection.livemode };
}

type TerminalPaymentRow = { id: string; reservationId: string | null; folioId: string | null; readerId: string; readerLabel: string | null; providerPaymentId: string; amountCents: number; status: string; paymentId: string | null; error: string | null; createdBy: string | null };

/**
 * Checks a charge on the reader. When the card is approved it is recorded on
 * the folio once (payment, ledger and activity log); a declined or failed
 * card is reported so staff can try again or take another payment.
 */
export async function refreshTerminalPayment(tx: Tx, propertyId: string, id: string) {
  const [row] = await tx<TerminalPaymentRow[]>`
    select id, reservation_id as "reservationId", folio_id as "folioId", reader_id as "readerId", reader_label as "readerLabel",
      provider_payment_id as "providerPaymentId", amount_cents as "amountCents", status, payment_id as "paymentId", error, created_by_auth_user_id as "createdBy"
    from terminal_payments where id=${id}::uuid and property_id=${propertyId}::uuid for update
  `;
  if (!row) return null;
  if (row.status !== "processing") return { id: row.id, status: row.status, error: row.error, paymentId: row.paymentId };
  const terminal = await requireTerminal(tx, propertyId);
  const intent = await stripeRequest<StripePaymentIntent>(terminal.key, "GET", `/v1/payment_intents/${row.providerPaymentId}`, { expand: ["latest_charge"] });
  if (intent.status === "succeeded") {
    const card = typeof intent.latest_charge === "object" ? intent.latest_charge?.payment_method_details?.card_present : undefined;
    const brand = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card";
    const businessDate = await propertyBusinessDate(tx, propertyId);
    const [payment] = await tx<Array<{ id: string }>>`
      insert into payments (property_id,reservation_id,method,amount_cents,currency_code,effective_date,last4,external_reference,note,terminal_payment_id)
      values (${propertyId}::uuid,${row.reservationId}::uuid,'Credit',${intent.amount},'USD',${businessDate}::date,${card?.last4 ?? null},${intent.id},
        ${`Card terminal · ${brand}${card?.last4 ? ` •••• ${card.last4}` : ""}${row.readerLabel ? ` · ${row.readerLabel}` : ""}`},${row.id}::uuid)
      returning id
    `;
    if (row.folioId) await tx`insert into payment_allocations (property_id,payment_id,folio_id,amount_cents) values (${propertyId}::uuid,${payment.id}::uuid,${row.folioId}::uuid,${intent.amount})`;
    await postPaymentLedger(tx, propertyId, payment.id);
    await tx`update terminal_payments set status='succeeded',payment_id=${payment.id}::uuid,updated_at=now() where id=${row.id}::uuid`;
    if (row.reservationId) await logReservationActivity(tx, { propertyId, authUserId: row.createdBy ?? undefined }, row.reservationId, "Payment", `Payment ${money(intent.amount)} · ${brand}${card?.last4 ? ` •••• ${card.last4}` : ""} on card terminal${row.readerLabel ? ` (${row.readerLabel})` : ""}`);
    return { id: row.id, status: "succeeded", error: null, paymentId: payment.id };
  }
  if (intent.status === "canceled") {
    await tx`update terminal_payments set status='canceled',updated_at=now() where id=${row.id}::uuid`;
    return { id: row.id, status: "canceled", error: null, paymentId: null };
  }
  // The reader reports a decline or a failure on its current action.
  const reader = await stripeRequest<StripeReader>(terminal.key, "GET", `/v1/terminal/readers/${encodeURIComponent(row.readerId)}`).catch(() => null);
  const failure = intent.last_payment_error?.message ?? (reader?.action?.status === "failed" ? reader.action.failure_message ?? "The card was not approved." : null);
  if (failure) {
    await stripeRequest(terminal.key, "POST", `/v1/payment_intents/${intent.id}/cancel`).catch(() => undefined);
    await tx`update terminal_payments set status='failed',error=${failure},updated_at=now() where id=${row.id}::uuid`;
    return { id: row.id, status: "failed", error: failure, paymentId: null };
  }
  return { id: row.id, status: "processing", error: null, paymentId: null };
}

export async function cancelTerminalPayment(tx: Tx, propertyId: string, id: string) {
  const [row] = await tx<TerminalPaymentRow[]>`
    select id, reader_id as "readerId", provider_payment_id as "providerPaymentId", status from terminal_payments where id=${id}::uuid and property_id=${propertyId}::uuid for update
  `;
  if (!row || row.status !== "processing") return false;
  const terminal = await requireTerminal(tx, propertyId);
  await stripeRequest(terminal.key, "POST", `/v1/terminal/readers/${encodeURIComponent(row.readerId)}/cancel_action`).catch(() => undefined);
  const intent = await stripeRequest<StripePaymentIntent>(terminal.key, "GET", `/v1/payment_intents/${row.providerPaymentId}`);
  // Never cancel a charge the card already approved: refresh records it instead.
  if (intent.status === "succeeded") return false;
  await stripeRequest(terminal.key, "POST", `/v1/payment_intents/${row.providerPaymentId}/cancel`).catch(() => undefined);
  await tx`update terminal_payments set status='canceled',updated_at=now() where id=${row.id}::uuid`;
  return true;
}

/** Test mode only: taps a test card on a simulated reader. */
export async function simulateCardTap(db: Db, propertyId: string, readerId: string) {
  const terminal = await requireTerminal(db, propertyId);
  if (terminal.connection.livemode) throw new TerminalError("A card can only be simulated in test mode.");
  await stripeRequest(terminal.key, "POST", `/v1/test_helpers/terminal/readers/${encodeURIComponent(readerId)}/present_payment_method`);
}

/**
 * Sends a refund back to the card when the payment was taken on the
 * terminal. Returns the processor's refund id, or null for keyed-in payments
 * (refunded outside the PMS as before).
 */
export async function refundOnProcessor(db: Db, propertyId: string, payment: { id: string; externalReference: string | null; terminalPaymentId: string | null }, amountCents: number, refundKey: string) {
  if (!payment.terminalPaymentId || !payment.externalReference?.startsWith("pi_")) return null;
  const terminal = await requireTerminal(db, propertyId);
  const refund = await stripeRequest<{ id: string; status: string }>(terminal.key, "POST", "/v1/refunds", { payment_intent: payment.externalReference, amount: amountCents }, `refund-${refundKey}`);
  if (refund.status === "failed" || refund.status === "canceled") throw new ProcessorError("The card processor did not accept the refund.");
  return refund.id;
}

/**
 * One paid payout → one deposit of the PMS payments (and refunds) it
 * contains, at Stripe's exact net. Payments the PMS did not take are left
 * out. Returns false when the payout holds no PMS payments.
 */
export async function recordPayout(tx: Tx, propertyId: string, depositBankAccountId: string | null, payout: { id: string; arrival_date: number }, transactions: StripeBalanceTransaction[]) {
  const [seen] = await tx`select 1 from card_settlements where property_id=${propertyId}::uuid and external_id=${payout.id}`;
  if (seen) return false;
  const intentOf = (txn: StripeBalanceTransaction) => typeof txn.source === "object" && txn.source ? txn.source.payment_intent ?? null : null;
  const refundIdOf = (txn: StripeBalanceTransaction) => typeof txn.source === "object" && txn.source?.object === "refund" ? txn.source.id : null;
  const charges = transactions.filter((txn) => (txn.type === "charge" || txn.type === "payment") && intentOf(txn));
  const refunds = transactions.filter((txn) => (txn.type === "refund" || txn.type === "payment_refund") && refundIdOf(txn));
  const payments = charges.length ? await tx<Array<{ id: string; ref: string }>>`
    select id, external_reference as ref from payments where property_id=${propertyId}::uuid and settlement_id is null and external_reference in ${tx(charges.map((txn) => intentOf(txn)!))}
  ` : [];
  const refundRows = refunds.length ? await tx<Array<{ id: string; ref: string }>>`
    select id, external_reference as ref from refunds where property_id=${propertyId}::uuid and settlement_id is null and external_reference in ${tx(refunds.map((txn) => refundIdOf(txn)!))}
  ` : [];
  if (!payments.length && !refundRows.length) return false;
  const matchedPayments = new Set(payments.map((item) => item.ref));
  const matchedRefunds = new Set(refundRows.map((item) => item.ref));
  const matched = [...charges.filter((txn) => matchedPayments.has(intentOf(txn)!)), ...refunds.filter((txn) => matchedRefunds.has(refundIdOf(txn)!))];
  const netCents = matched.reduce((sum, txn) => sum + txn.net, 0);
  const bankAccount = await bankAccountFor(tx, propertyId, depositBankAccountId);
  const settlement = await settleDeposit(tx, {
    propertyId, bankAccount, paymentIds: payments.map((item) => item.id), refundIds: refundRows.map((item) => item.id), netCents,
    depositDate: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10), reference: payout.id, automatic: true,
    note: `Stripe payout${matched.length < charges.length + refunds.length ? " (other sales in this payout are not PMS payments)" : ""}`,
  });
  await tx`update card_settlements set external_id=${payout.id} where id=${settlement.id}::uuid`;
  return true;
}

/**
 * Turns each paid Stripe payout into a deposit in the motel's bank account,
 * with the exact fees Stripe kept. Only charges and refunds the PMS took are
 * matched; a payout is recorded once (by its id).
 */
export async function syncPayouts(sql: Sql, propertyId: string) {
  const terminal = await activeTerminal(sql, propertyId);
  if (!terminal) return { deposits: 0 };
  const since = Math.floor(Date.parse(terminal.connection.lastPayoutSyncAt ?? new Date(Date.now() - 60 * 86_400_000).toISOString()) / 1000) - 7 * 86_400;
  try {
    const payouts = await stripeList<{ id: string; amount: number; arrival_date: number; status: string }>(terminal.key, "/v1/payouts", { status: "paid", arrival_date: { gte: since } }, 300);
    let deposits = 0;
    for (const payout of payouts) {
      const [seen] = await sql`select 1 from card_settlements where property_id=${propertyId}::uuid and external_id=${payout.id}`;
      if (seen) continue;
      const transactions = await stripeList<StripeBalanceTransaction>(terminal.key, "/v1/balance_transactions", { payout: payout.id, expand: ["data.source"] }, 2000);
      const created = await sql.begin((tx) => recordPayout(tx, propertyId, terminal.connection.depositBankAccountId, payout, transactions));
      if (created) deposits += 1;
    }
    await sql`update payment_terminal_connections set last_payout_sync_at=now(),last_error=null,updated_at=now() where id=${terminal.connection.id}::uuid`;
    return { deposits };
  } catch (error) {
    const message = error instanceof DepositError || error instanceof ProcessorError ? error.message : "Payout sync failed.";
    await sql`update payment_terminal_connections set last_error=${message},updated_at=now() where id=${terminal.connection.id}::uuid`;
    throw error;
  }
}

/**
 * Finishes charges left waiting (the screen was closed while the guest tapped
 * the card): an approved card is still posted to the folio, an abandoned one
 * is cancelled.
 */
export async function settleStaleTerminalPayments(sql: Sql, propertyId: string, olderThanSeconds = 30) {
  const stale = await sql<Array<{ id: string }>>`
    select id from terminal_payments where property_id=${propertyId}::uuid and status='processing' and created_at < now() - make_interval(secs => ${olderThanSeconds})
  `;
  let finished = 0;
  for (const item of stale) {
    try {
      const result = await sql.begin((tx) => refreshTerminalPayment(tx, propertyId, item.id));
      if (result?.status === "processing") {
        // Nobody tapped a card within 15 minutes: release the reader.
        const [old] = await sql`select 1 from terminal_payments where id=${item.id}::uuid and created_at < now() - interval '15 minutes'`;
        if (old) await sql.begin((tx) => cancelTerminalPayment(tx, propertyId, item.id));
      } else finished += 1;
    } catch {
      // Try again next time; one charge must not stop the others.
    }
  }
  return finished;
}
