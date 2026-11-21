import type { Sql } from "postgres";

type Candidate = {
  propertyId: string; membershipId: string; firstName: string; phone: string | null; email: string | null;
  smsConsent: boolean; emailConsent: boolean; memberNumber: string; rewardDescription: string;
  nightsRequired: number; balance: number; availableRewards: number; settings: Record<string, unknown>;
};

function fill(template: string, row: Candidate, nightsLeft: number) {
  return template.replaceAll("{firstName}", row.firstName).replaceAll("{nightsLeft}", String(nightsLeft))
    .replaceAll("{reward}", row.rewardDescription).replaceAll("{memberId}", row.memberNumber);
}

async function sendSms(to: string, message: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID; const token = process.env.TWILIO_AUTH_TOKEN; const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error("SMS provider is not configured.");
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`SMS provider returned ${response.status}.`);
}

async function sendEmail(to: string, subject: string, message: string) {
  const key = process.env.RESEND_API_KEY; const from = process.env.LOYALTY_EMAIL_FROM;
  if (!key || !from) throw new Error("Email provider is not configured.");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text: message }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
}

export async function processLoyaltyReminders(sql: Sql) {
  await sql`update loyalty_rewards set status='expired',updated_at=now() where status='available' and expires_at is not null and expires_at<=now()`;
  const candidates = await sql<Candidate[]>`
    select lm.property_id as "propertyId",lm.id as "membershipId",g.first_name as "firstName",g.phone,g.email,
      lm.sms_consent as "smsConsent",lm.email_consent as "emailConsent",lm.member_number as "memberNumber",
      coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",
      coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
      coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id),0)::int as balance,
      (select count(*)::int from loyalty_rewards where membership_id=lm.id and status='available' and (expires_at is null or expires_at>now())) as "availableRewards",
      lp.reminder_settings as settings
    from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id join guests g on g.id=lm.guest_id
    where lm.status='active' and lp.status='active' and g.guest_status<>'do_not_rent'
      and coalesce((lp.reminder_settings->>'enabled')::boolean,false)
  `;
  let queued = 0; let sent = 0; let failed = 0;
  for (const row of candidates) {
    const nightsLeft = Math.max(0, row.nightsRequired - Math.max(0, row.balance));
    const targets = Array.isArray(row.settings.nightsRemaining) ? row.settings.nightsRemaining.map(Number) : [2, 1];
    const rewardReady = row.availableRewards > 0 && row.settings.sendRewardReady !== false;
    if (!rewardReady && !targets.includes(nightsLeft)) continue;
    const smsTemplate = String(row.settings.smsTemplate ?? "Hi {firstName}, you are {nightsLeft} night(s) away from {reward}. Member ID: {memberId}.");
    const emailTemplate = String(row.settings.emailTemplate ?? smsTemplate);
    const subject = String(row.settings.emailSubject ?? "Your loyalty progress");
    const channels: Array<{ channel: "sms" | "email"; to: string; message: string }> = [];
    if (row.smsConsent && row.phone) channels.push({ channel: "sms", to: row.phone, message: rewardReady ? fill(smsTemplate, row, 0).replace("0 night(s) away from", "your reward is ready:") : fill(smsTemplate, row, nightsLeft) });
    if (row.emailConsent && row.email) channels.push({ channel: "email", to: row.email, message: rewardReady ? fill(emailTemplate, row, 0).replace("0 night(s) away from", "your reward is ready:") : fill(emailTemplate, row, nightsLeft) });
    for (const delivery of channels) {
      const target = rewardReady ? "ready" : `left-${nightsLeft}`;
      const [reminder] = await sql<Array<{ id: string }>>`
        insert into loyalty_reminders (property_id,membership_id,channel,status,subject,message,idempotency_key)
        select ${row.propertyId}::uuid,${row.membershipId}::uuid,${delivery.channel},'queued',${delivery.channel === "email" ? subject : null},${delivery.message},
          ${`auto:${row.membershipId}:${delivery.channel}:${target}:${new Date().toISOString().slice(0,10)}`}
        where not exists (select 1 from loyalty_reminders where membership_id=${row.membershipId}::uuid and channel=${delivery.channel} and status='sent' and created_at>now()-interval '7 days')
        on conflict (property_id,idempotency_key) do nothing returning id
      `;
      if (!reminder) continue;
      queued += 1;
      try {
        if (delivery.channel === "sms") await sendSms(delivery.to, delivery.message); else await sendEmail(delivery.to, subject, delivery.message);
        await sql`update loyalty_reminders set status='sent',sent_at=now() where id=${reminder.id}::uuid`; sent += 1;
      } catch (error) {
        await sql`update loyalty_reminders set status='failed',error=${error instanceof Error ? error.message : "Delivery failed"} where id=${reminder.id}::uuid`; failed += 1;
      }
    }
  }
  return { queued, sent, failed };
}
