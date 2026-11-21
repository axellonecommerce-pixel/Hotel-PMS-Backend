import { createHash } from "node:crypto";

import QRCode from "qrcode";

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

function friendlyDate(value: unknown) {
  const source = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${source}T00:00:00Z`));
}

function qualificationCopy(card: Record<string, unknown>) {
  if (card.qualificationType === "days" && Number(card.qualificationDays) > 0) {
    return `Complete ${Number(card.nightsRequired)} nights within ${Number(card.qualificationDays)} days · through ${friendlyDate(card.qualificationEndsOn)}`;
  }
  if (card.qualificationType === "date_range") {
    return `Qualifying stays: ${friendlyDate(card.qualificationStartsOn)} – ${friendlyDate(card.qualificationEndsOn)}`;
  }
  return "No time limit on qualifying nights";
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Card not found.", { status: 404 });
  const hash = createHash("sha256").update(token).digest("hex");
  const [card] = await productionSql()<Array<Record<string, unknown>>>`
    select coalesce(nullif(ps.value->'property'->>'name',''),p.name) as "propertyName",
      ps.value->'property'->>'logoDataUrl' as "logoDataUrl",g.first_name as "firstName",left(g.last_name,1) as "lastInitial",
      lm.member_number as "memberNumber",lm.status,lp.name as "programName",
      eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",eo.terms,
      eo.qualification_type as "qualificationType",eo.qualification_days as "qualificationDays",
      lmp.effective_starts_on::text as "qualificationStartsOn",lmp.effective_ends_on::text as "qualificationEndsOn",
      lmp.qualification_status as "qualificationStatus",lmp.progress_nights as "progressNights",
      greatest(coalesce((select sum(nights_delta) from loyalty_transactions where membership_id=lm.id and type in ('enrollment_credit','stay_credit','stay_reversal')),0),0)::int as "totalQualifyingNights",
      (select count(*)::int from loyalty_rewards where membership_id=lm.id and status='available' and (expires_at is null or expires_at>now())) as "availableRewards"
    from loyalty_wallet_passes wp join loyalty_memberships lm on lm.id=wp.membership_id
    join loyalty_programs lp on lp.id=lm.program_id join guests g on g.id=lm.guest_id join properties p on p.id=lm.property_id
    left join property_settings ps on ps.property_id=p.id and ps.key='application_settings'
    join loyalty_effective_offers eo on eo.membership_id=lm.id
    join loyalty_member_progress lmp on lmp.membership_id=lm.id
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
  const propertyLogo = logo ? `<img class="property-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(card.propertyName)} logo">` : `<span class="property-fallback" aria-hidden="true">${escapeHtml(String(card.propertyName).slice(0, 1))}</span>`;
  const qrDataUrl = await QRCode.toDataURL(request.url, { width: 300, margin: 1, errorCorrectionLevel: "M", color: { dark: "#092548", light: "#ffffff" } });
  const period = qualificationCopy(card);
  const periodState = card.qualificationStatus === "ended" ? "Earning period ended" : card.qualificationStatus === "upcoming" ? "Earning period begins soon" : period;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(card.programName)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% 10%,#fff 0,#eef6fd 48%,#e5f0fa 100%);color:#092548;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{min-height:100svh;display:grid;place-items:center;padding:28px}.card{width:min(100%,600px);overflow:hidden;border:1px solid #0b315826;border-radius:32px;background:#fff;box-shadow:0 30px 90px #08254832}.top{position:relative;isolation:isolate;overflow:hidden;padding:26px 30px 52px;background:linear-gradient(105deg,#062746ee 0%,#064779e8 56%,#062746d9 100%),linear-gradient(155deg,#123c5b 0 43%,#d08933 44% 48%,#103653 49% 100%);color:#fff}.top:before{position:absolute;z-index:-1;inset:0;background:radial-gradient(circle at 78% 62%,#ffc15c30 0 2%,transparent 3%),linear-gradient(154deg,transparent 0 63%,#071c30aa 64% 100%);content:""}.top:after{position:absolute;right:-2%;bottom:0;width:72%;height:42%;background:linear-gradient(165deg,transparent 0 34%,#f6b7424d 35% 38%,#071b2e 39% 100%);clip-path:polygon(0 100%,13% 59%,24% 72%,38% 32%,48% 59%,65% 20%,100% 48%,100% 100%);content:""}.brands{position:relative;z-index:1;display:flex;align-items:center;gap:18px}.innseva{display:flex;min-width:0;align-items:center;gap:10px}.innseva-mark{display:grid;width:46px;height:46px;flex:0 0 46px;place-items:center;border-radius:13px;background:#fff;color:#092f53}.innseva-mark svg{width:29px;height:29px}.innseva-name{font-size:21px;font-weight:950;line-height:1}.innseva-tag{margin-top:4px;color:#ffffffc9;font-size:10px}.divider{width:1px;height:50px;background:#ffffff75}.property-brand{display:flex;min-width:0;flex:1;align-items:center;justify-content:center;gap:12px;text-align:center}.property-name{font-family:Georgia,serif;font-size:clamp(17px,4vw,24px);font-weight:900;line-height:1.05;text-transform:uppercase}.property-label{margin-top:5px;color:#ffd474;font-size:9px;font-weight:900;letter-spacing:.2em;text-transform:uppercase}.property-logo,.property-fallback{width:62px;height:62px;flex:0 0 62px;border:1px solid #ffffff4d;border-radius:16px;background:#fffffff2;object-fit:contain;padding:4px}.property-fallback{display:grid;place-items:center;color:#092f53;font-size:30px;font-weight:950}.eyebrow{position:relative;z-index:1;margin-top:30px;color:#ffffffd6;font-size:13px;font-weight:900;letter-spacing:.3em;text-transform:uppercase}h1{position:relative;z-index:1;margin:7px 0 0;max-width:90%;font-size:clamp(30px,7vw,43px);line-height:1.03}.wave{height:25px;margin-top:-25px;position:relative;z-index:2;background:#fff;border-radius:50% 50% 0 0/100% 100% 0 0;border-top:5px solid #ffd36d}.body{padding:22px 30px 0}.identity{display:grid;grid-template-columns:66px minmax(0,1fr);align-items:center;gap:17px}.bed{display:grid;width:66px;height:66px;place-items:center;border-radius:19px;background:#e6f1fa}.bed svg{width:36px;height:36px}.person{min-width:0;border-left:2px solid #d7e6f3;padding-left:17px}.guest{overflow:hidden;font-size:clamp(24px,6vw,32px);font-weight:950;text-overflow:ellipsis;white-space:nowrap}.member-label{margin-top:3px;color:#53769b;font-size:15px;font-weight:700}.number{margin-top:2px;overflow-wrap:anywhere;font-size:14px;font-weight:950;letter-spacing:.035em}.progress-grid{display:grid;grid-template-columns:minmax(0,1fr) 122px;align-items:end;gap:24px;margin-top:32px}.progress{height:13px;overflow:hidden;border-radius:999px;background:#dbeaf5}.bar{height:100%;width:${Math.min(100, progress / required * 100)}%;border-radius:inherit;background:linear-gradient(90deg,#05865f,#0a9a70)}.count{margin-top:13px;font-size:clamp(31px,8vw,43px);font-weight:950;letter-spacing:-.04em}.hint{margin-top:2px;color:#53769b;font-size:17px}.total{margin-top:7px;color:#315a83;font-size:14px;font-weight:850}.period{margin-top:8px;color:#6a7581;font-size:12px;font-weight:700}.qr{width:122px;height:122px;border-radius:12px;background:#fff;box-shadow:0 8px 25px #0825481f}.reward{display:flex;align-items:center;gap:16px;margin-top:28px;border:1px solid #f2c45f;border-radius:19px;background:linear-gradient(100deg,#fff4cf,#fffaf0);padding:18px 20px;box-shadow:0 9px 24px #bf7e0024}.gift{display:grid;width:50px;height:50px;flex:0 0 50px;place-items:center;border-radius:14px;background:#ffedbb;color:#8b5a00}.gift svg{width:29px;height:29px}.reward-label{color:#8b5a00;font-size:10px;font-weight:900;letter-spacing:.15em;text-transform:uppercase}.reward-name{margin-top:2px;color:#101820;font-size:clamp(20px,5vw,25px);font-weight:950}.terms{margin-top:5px;color:#6c5a36;font-size:11px;line-height:1.45}.landscape{position:relative;height:105px;margin:26px -30px 0;overflow:hidden;background:linear-gradient(166deg,transparent 0 29%,#dbeaf5 30% 48%,transparent 49%),linear-gradient(24deg,#c5dced 0 44%,transparent 45%),linear-gradient(180deg,transparent 62%,#9fc2dc 63%)}.landscape:after{position:absolute;right:-5%;bottom:-54px;width:68%;height:90px;border:8px solid #fff;border-left-color:transparent;border-radius:50%;content:""}.wallets{display:grid;gap:10px;margin-top:20px}.wallet{display:flex;min-height:50px;align-items:center;justify-content:center;border-radius:13px;background:#111;color:#fff;font-weight:850;text-decoration:none}.wallet:focus-visible{outline:3px solid #f2c45f;outline-offset:3px}.foot{display:flex;align-items:center;gap:16px;background:linear-gradient(100deg,#092b4c,#06345d);padding:21px 30px;color:#ffffffe8}.info{display:grid;width:36px;height:36px;flex:0 0 36px;place-items:center;border:2px solid #fff;border-radius:50%;font-size:22px;font-weight:900}.fine{margin:0;border-left:1px solid #ffffff80;padding-left:17px;font-size:13px;line-height:1.55}.powered{font-weight:900;color:#fff}@media(max-width:520px){.wrap{padding:10px}.card{border-radius:24px}.top{padding:20px 18px 42px}.brands{gap:10px}.innseva-name{font-size:17px}.innseva-tag{display:none}.divider{height:40px}.property-logo,.property-fallback{width:48px;height:48px;flex-basis:48px}.property-name{font-size:15px}.body{padding:20px 18px 0}.identity{grid-template-columns:54px minmax(0,1fr)}.bed{width:54px;height:54px}.progress-grid{grid-template-columns:minmax(0,1fr) 92px;gap:13px}.qr{width:92px;height:92px}.hint{font-size:15px}.landscape{margin-left:-18px;margin-right:-18px}.foot{padding:18px}.fine{font-size:12px}}
</style></head>
<body><main class="wrap"><article class="card"><header class="top"><div class="brands"><div class="innseva"><span class="innseva-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5l7-3 7 3v16M3 21h18M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 21v-5h6v5"/></svg></span><div><div class="innseva-name">InnSeva</div><div class="innseva-tag">Hospitality Management</div></div></div><span class="divider" aria-hidden="true"></span><div class="property-brand"><div><div class="property-name">${escapeHtml(card.propertyName)}</div><div class="property-label">Official motel rewards</div></div>${propertyLogo}</div></div><div class="eyebrow">${escapeHtml(card.propertyName)}</div><h1>${escapeHtml(card.programName)}</h1></header><div class="wave" aria-hidden="true"></div><section class="body"><div class="identity"><div class="bed" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16M22 20V9a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v11M2 13h20M5 7h3"/></svg></div><div class="person"><div class="guest">${escapeHtml(card.firstName)} ${escapeHtml(card.lastInitial)}.</div><div class="member-label">Member ID</div><div class="number">${escapeHtml(card.memberNumber)}</div></div></div><div class="progress-grid"><div><div class="progress" role="progressbar" aria-label="Loyalty progress" aria-valuemin="0" aria-valuemax="${required}" aria-valuenow="${progress}"><div class="bar"></div></div><div class="count">${progress} of ${required} nights</div><div class="hint">${remaining ? `${remaining} ${remaining === 1 ? "night" : "nights"} until your next reward` : "Your next reward is ready"}</div><div class="total">${escapeHtml(card.totalQualifyingNights)} total qualifying nights stayed</div><div class="period">${escapeHtml(periodState)}</div></div><img class="qr" src="${escapeHtml(qrDataUrl)}" alt="QR code for member ${escapeHtml(card.memberNumber)}"></div><div class="reward"><div class="gift" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M7.5 8C5 8 4 6.8 4 5.5S5 3 6.5 3C9 3 12 8 12 8s3-5 5.5-5C19 3 20 4.2 20 5.5S19 8 16.5 8"/></svg></div><div><div class="reward-label">${Number(card.availableRewards) ? `${escapeHtml(card.availableRewards)} reward${Number(card.availableRewards) === 1 ? "" : "s"} ready` : "Your next reward"}</div><div class="reward-name">${escapeHtml(card.rewardDescription)}</div>${card.terms ? `<div class="terms">${escapeHtml(card.terms)}</div>` : ""}</div></div>${buttons ? `<div class="wallets">${buttons}</div>` : ""}<div class="landscape" aria-hidden="true"></div></section><footer class="foot"><span class="info" aria-hidden="true">i</span><p class="fine">Show this card or your member ID at the motel. Reward eligibility is confirmed at redemption. <span class="powered">Powered by InnSeva.</span></p></footer></article></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
}
