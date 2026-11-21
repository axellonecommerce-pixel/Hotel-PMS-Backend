import { createHash } from "node:crypto";

import { productionSql } from "@/server/db/production";

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function providerUrl(base: string | undefined, token: string) {
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Card not found.", { status: 404 });
  const hash = createHash("sha256").update(token).digest("hex");
  const [card] = await productionSql()<Array<Record<string, unknown>>>`
    select p.name as "propertyName",g.first_name as "firstName",left(g.last_name,1) as "lastInitial",
      lm.member_number as "memberNumber",lm.status,lp.name as "programName",
      coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
      coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id),0),0)::int as "progressNights",
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id and type in ('enrollment_credit','stay_credit','stay_reversal')),0),0)::int as "totalQualifyingNights",
      (select count(*)::int from loyalty_rewards where membership_id=lm.id and status='available') as "availableRewards"
    from loyalty_wallet_passes wp join loyalty_memberships lm on lm.id=wp.membership_id
    join loyalty_programs lp on lp.id=lm.program_id join guests g on g.id=lm.guest_id join properties p on p.id=lm.property_id
    where wp.token_hash=${hash} and wp.platform='web' and wp.status='active' and lm.status<>'closed'
  `;
  if (!card) return new Response("Card not found or replaced.", { status: 404 });
  const progress = Math.max(0, Number(card.progressNights));
  const required = Math.max(1, Number(card.nightsRequired));
  const remaining = Math.max(0, required - progress);
  const apple = providerUrl(process.env.APPLE_WALLET_PASS_URL, token);
  const google = providerUrl(process.env.GOOGLE_WALLET_SAVE_URL, token);
  const buttons = [apple ? `<a class="wallet" href="${escapeHtml(apple)}">Add to Apple Wallet</a>` : "", google ? `<a class="wallet" href="${escapeHtml(google)}">Add to Google Wallet</a>` : ""].join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(card.programName)}</title><style>body{margin:0;background:#eef2f6;color:#10233f;font-family:ui-sans-serif,system-ui,sans-serif}.wrap{min-height:100svh;display:grid;place-items:center;padding:24px}.card{width:min(100%,420px);overflow:hidden;border-radius:24px;background:#fff;box-shadow:0 20px 60px #10233f24}.top{padding:28px;background:#102b4e;color:#fff}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.8}h1{margin:8px 0 0;font-size:26px}.body{padding:28px}.member{color:#5d6b7d;font-size:14px}.number{margin-top:4px;font-size:20px;font-weight:900;letter-spacing:.05em}.progress{height:12px;margin-top:24px;overflow:hidden;border-radius:999px;background:#dce5ef}.bar{height:100%;width:${Math.min(100, progress / required * 100)}%;background:#1d6f5f}.count{margin-top:12px;font-size:22px;font-weight:900}.hint{margin-top:4px;color:#5d6b7d}.total{margin-top:8px;color:#405168;font-size:14px;font-weight:700}.reward{margin-top:20px;border-radius:16px;background:#edf7f4;padding:16px;font-weight:800}.wallets{display:grid;gap:10px;margin-top:20px}.wallet{display:flex;min-height:48px;align-items:center;justify-content:center;border-radius:12px;background:#111;color:#fff;font-weight:800;text-decoration:none}.fine{margin-top:22px;color:#687789;font-size:12px;line-height:1.5}</style></head><body><main class="wrap"><article class="card"><header class="top"><div class="eyebrow">${escapeHtml(card.propertyName)}</div><h1>${escapeHtml(card.programName)}</h1></header><section class="body"><div class="member">${escapeHtml(card.firstName)} ${escapeHtml(card.lastInitial)}. · Member ID</div><div class="number">${escapeHtml(card.memberNumber)}</div><div class="progress" role="progressbar" aria-label="Loyalty progress" aria-valuemin="0" aria-valuemax="${required}" aria-valuenow="${progress}"><div class="bar"></div></div><div class="count">${progress} of ${required} nights</div><div class="hint">${remaining ? `${remaining} ${remaining === 1 ? "night" : "nights"} until your next reward` : "Your next reward is ready"}</div><div class="total">${escapeHtml(card.totalQualifyingNights)} total qualifying nights stayed</div><div class="reward">${Number(card.availableRewards) ? `${escapeHtml(card.availableRewards)} available · ` : ""}${escapeHtml(card.rewardDescription)}</div>${buttons ? `<div class="wallets">${buttons}</div>` : ""}<p class="fine">Show this card or your member ID at the motel. Reward eligibility is confirmed by the motel at redemption.</p></section></article></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
}
