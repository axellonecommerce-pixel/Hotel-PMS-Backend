import { createHash } from "node:crypto";

import { productionSql } from "@/server/db/production";

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function providerUrl(base: string | undefined, token: string) {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return null;
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}

function safeLogoUrl(value: unknown) {
  const source = String(value ?? "");
  return /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(source) ? source : null;
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Card not found.", { status: 404 });
  const hash = createHash("sha256").update(token).digest("hex");
  const [card] = await productionSql()<Array<Record<string, unknown>>>`
    select coalesce(nullif(ps.value->'property'->>'name',''),p.name) as "propertyName",
      ps.value->'property'->>'logoDataUrl' as "logoDataUrl",g.first_name as "firstName",left(g.last_name,1) as "lastInitial",
      lm.member_number as "memberNumber",lm.status,lp.name as "programName",
      eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",eo.terms,
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id),0),0)::int as "progressNights",
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id and type in ('enrollment_credit','stay_credit','stay_reversal')),0),0)::int as "totalQualifyingNights",
      (select count(*)::int from loyalty_rewards where membership_id=lm.id and status='available' and (expires_at is null or expires_at>now())) as "availableRewards"
    from loyalty_wallet_passes wp join loyalty_memberships lm on lm.id=wp.membership_id
    join loyalty_programs lp on lp.id=lm.program_id join guests g on g.id=lm.guest_id join properties p on p.id=lm.property_id
    left join property_settings ps on ps.property_id=p.id and ps.key='application_settings'
    join loyalty_effective_offers eo on eo.membership_id=lm.id
    where wp.token_hash=${hash} and wp.platform='web' and wp.status='active' and lm.status<>'closed'
  `;
  if (!card) return new Response("Card not found or replaced.", { status: 404 });
  const progress = Math.max(0, Number(card.progressNights));
  const required = Math.max(1, Number(card.nightsRequired));
  const remaining = Math.max(0, required - progress);
  const apple = providerUrl(process.env.APPLE_WALLET_PASS_URL, token);
  const google = providerUrl(process.env.GOOGLE_WALLET_SAVE_URL, token);
  const buttons = [apple ? `<a class="wallet" href="${escapeHtml(apple)}">Add to Apple Wallet</a>` : "", google ? `<a class="wallet" href="${escapeHtml(google)}">Add to Google Wallet</a>` : ""].join("");
  const logo = safeLogoUrl(card.logoDataUrl);
  const propertyLogo = logo ? `<img class="property-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(card.propertyName)} logo">` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(card.programName)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#edf5fc,#f8fbff);color:#092548;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{min-height:100svh;display:grid;place-items:center;padding:24px}.card{width:min(100%,560px);overflow:hidden;border:1px solid #0b315826;border-radius:30px;background:#fff;box-shadow:0 28px 80px #08254832}.top{position:relative;isolation:isolate;overflow:hidden;padding:24px 28px 40px;background:linear-gradient(135deg,#062746,#07528a 60%,#0a3158);color:#fff}.top:before{position:absolute;z-index:-1;top:-110px;right:-90px;width:300px;height:300px;border-radius:50%;background:#f7b73328;filter:blur(24px);content:""}.brands{display:flex;align-items:center;justify-content:space-between;gap:18px}.innseva{display:flex;min-width:0;align-items:center;gap:10px}.innseva-mark{display:grid;width:42px;height:42px;flex:0 0 42px;place-items:center;border-radius:12px;background:#fff;color:#092f53}.innseva-mark svg{width:27px;height:27px}.innseva-name{font-size:20px;font-weight:900;line-height:1}.innseva-tag{margin-top:4px;color:#ffffffb8;font-size:10px}.divider{width:1px;height:44px;background:#ffffff66}.property-brand{display:flex;min-width:0;flex:1;align-items:center;justify-content:flex-end;gap:12px;text-align:right}.property-name{overflow:hidden;font-size:15px;font-weight:900;text-overflow:ellipsis;white-space:nowrap}.property-label{margin-top:3px;color:#ffffffb8;font-size:9px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.property-logo{width:58px;height:58px;flex:0 0 58px;border:1px solid #ffffff40;border-radius:14px;background:#fffffff2;object-fit:contain;padding:4px}.eyebrow{margin-top:30px;color:#ffffffc7;font-size:12px;font-weight:900;letter-spacing:.26em;text-transform:uppercase}h1{margin:6px 0 0;font-size:clamp(27px,7vw,38px);line-height:1.05}.body{padding:28px}.identity{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:16px}.bed{display:grid;width:64px;height:64px;place-items:center;border-radius:18px;background:#e9f3fb}.bed svg{width:34px;height:34px}.person{min-width:0;border-left:2px solid #d7e6f3;padding-left:16px}.guest{overflow:hidden;font-size:clamp(22px,6vw,30px);font-weight:950;text-overflow:ellipsis;white-space:nowrap}.member-label{margin-top:3px;color:#53769b;font-size:14px;font-weight:700}.number{margin-top:2px;overflow-wrap:anywhere;font-size:14px;font-weight:950;letter-spacing:.035em}.progress{height:13px;margin-top:30px;overflow:hidden;border-radius:999px;background:#dbeaf5}.bar{height:100%;width:${Math.min(100, progress / required * 100)}%;border-radius:inherit;background:linear-gradient(90deg,#05865f,#0a9a70)}.count{margin-top:13px;font-size:clamp(30px,8vw,42px);font-weight:950;letter-spacing:-.035em}.hint{margin-top:2px;color:#53769b;font-size:17px}.total{margin-top:7px;color:#315a83;font-size:14px;font-weight:800}.reward{display:flex;align-items:center;gap:15px;margin-top:26px;border:1px solid #f2c45f;border-radius:18px;background:linear-gradient(100deg,#fff6d9,#fffaf0);padding:17px 19px;box-shadow:0 8px 22px #bf7e001f}.gift{display:grid;width:48px;height:48px;flex:0 0 48px;place-items:center;border-radius:13px;background:#ffedbb}.gift svg{width:28px;height:28px}.reward-label{color:#8b5a00;font-size:10px;font-weight:900;letter-spacing:.15em;text-transform:uppercase}.reward-name{margin-top:2px;color:#172033;font-size:20px;font-weight:950}.terms{margin-top:6px;color:#6c5a36;font-size:11px;line-height:1.45}.landscape{height:68px;margin-top:25px;border-radius:28px 28px 0 0;background:linear-gradient(155deg,transparent 0 17%,#dceaf5 18% 42%,transparent 43%),linear-gradient(25deg,#c9dfef 0 38%,transparent 39%),linear-gradient(180deg,transparent 64%,#afcee4 65%);opacity:.9}.wallets{display:grid;gap:10px;margin-top:20px}.wallet{display:flex;min-height:50px;align-items:center;justify-content:center;border-radius:13px;background:#111;color:#fff;font-weight:850;text-decoration:none}.foot{display:flex;align-items:center;gap:16px;background:linear-gradient(100deg,#092b4c,#06345d);padding:20px 28px;color:#ffffffe8}.info{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;border:2px solid #fff;border-radius:50%;font-size:21px;font-weight:900}.fine{margin:0;border-left:1px solid #ffffff80;padding-left:16px;font-size:13px;line-height:1.55}.powered{font-weight:850;color:#fff}@media(max-width:480px){.wrap{padding:12px}.card{border-radius:23px}.top{padding:20px 19px 32px}.innseva-name{font-size:17px}.innseva-tag{display:none}.divider{height:38px}.property-logo{width:48px;height:48px;flex-basis:48px}.body{padding:22px 19px}.identity{grid-template-columns:54px minmax(0,1fr)}.bed{width:54px;height:54px}.foot{padding:18px 19px}.fine{font-size:12px}}
</style></head>
<body><main class="wrap"><article class="card"><header class="top"><div class="brands"><div class="innseva"><span class="innseva-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5l7-3 7 3v16M3 21h18M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 21v-5h6v5"/></svg></span><div><div class="innseva-name">InnSeva</div><div class="innseva-tag">Hospitality Management</div></div></div><span class="divider" aria-hidden="true"></span><div class="property-brand"><div><div class="property-name">${escapeHtml(card.propertyName)}</div><div class="property-label">Property rewards</div></div>${propertyLogo}</div></div><div class="eyebrow">${escapeHtml(card.propertyName)}</div><h1>${escapeHtml(card.programName)}</h1></header><section class="body"><div class="identity"><div class="bed" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16M22 20V9a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v11M2 13h20M5 7h3"/></svg></div><div class="person"><div class="guest">${escapeHtml(card.firstName)} ${escapeHtml(card.lastInitial)}.</div><div class="member-label">Member ID</div><div class="number">${escapeHtml(card.memberNumber)}</div></div></div><div class="progress" role="progressbar" aria-label="Loyalty progress" aria-valuemin="0" aria-valuemax="${required}" aria-valuenow="${progress}"><div class="bar"></div></div><div class="count">${progress} of ${required} nights</div><div class="hint">${remaining ? `${remaining} ${remaining === 1 ? "night" : "nights"} until your next reward` : "Your next reward is ready"}</div><div class="total">${escapeHtml(card.totalQualifyingNights)} total qualifying nights stayed</div><div class="reward"><div class="gift" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M7.5 8C5 8 4 6.8 4 5.5S5 3 6.5 3C9 3 12 8 12 8s3-5 5.5-5C19 3 20 4.2 20 5.5S19 8 16.5 8"/></svg></div><div><div class="reward-label">${Number(card.availableRewards) ? `${escapeHtml(card.availableRewards)} reward${Number(card.availableRewards) === 1 ? "" : "s"} ready` : "Your next reward"}</div><div class="reward-name">${escapeHtml(card.rewardDescription)}</div>${card.terms ? `<div class="terms">${escapeHtml(card.terms)}</div>` : ""}</div></div>${buttons ? `<div class="wallets">${buttons}</div>` : ""}<div class="landscape" aria-hidden="true"></div></section><footer class="foot"><span class="info" aria-hidden="true">i</span><p class="fine">Show this card or your member ID at the motel. Reward eligibility is confirmed at redemption. <span class="powered">Powered by InnSeva.</span></p></footer></article></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
}
