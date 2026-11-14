import { createHash } from "node:crypto";

import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { hashFolioToken } from "@/server/guest-messages/folio-links";

/**
 * The page a guest opens from a folio link (/f/<code>): the folio exactly as
 * the motel printed it when sending, with a Print / Save as PDF button.
 *
 * Locked down: the page runs in a sandbox with no access to InnSeva, loads
 * nothing from anywhere else, and runs no script except the print button.
 */
const printScript = `document.getElementById("innseva-print").addEventListener("click",function(){window.print()});`;
const printScriptHash = createHash("sha256").update(printScript).digest("base64");
const securityPolicy = [
  "sandbox allow-scripts allow-modals",
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${printScriptHash}'`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Width of the printed folio page plus a margin (document-print.ts PAGE_WIDTH_PX). */
const FOLIO_PAGE_WIDTH = 860;

const toolbar = `<style>
  .innseva-bar{display:flex;justify-content:center;gap:8px;padding:20px 16px;background:#f4f4f5;border-bottom:1px solid #e4e4e7;font:14px system-ui,sans-serif}
  .innseva-bar button{min-height:72px;padding:0 36px;border:0;border-radius:12px;background:#18181b;color:#fff;font:600 28px system-ui,sans-serif;cursor:pointer}
  @media print{.innseva-bar{display:none}}
</style><div class="innseva-bar"><button id="innseva-print" type="button">Print / Save as PDF</button></div>`;

const page = (status: number, body: string, title = "Folio") => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font:16px system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center;color:#3f3f46">${body}</body></html>`,
  { status, headers: headers() },
);

function headers() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": securityPolicy,
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return page(404, "<p>This folio link is not valid.</p>");
  if (!hasProductionDatabase()) return page(503, "<p>The folio is unavailable right now. Please try again later.</p>");
  const [link] = await productionSql()<Array<{ id: string; documentHtml: string; revoked: boolean }>>`
    select id, document_html as "documentHtml", revoked_at is not null as revoked
    from folio_share_links where token_hash=${hashFolioToken(token)}
  `;
  if (!link) return page(404, "<p>This folio link is not valid.</p>");
  if (link.revoked) return page(410, "<p>This folio link was turned off by the property. Please contact them for a copy.</p>");
  await productionSql()`
    update folio_share_links set open_count=open_count+1, last_opened_at=now(), first_opened_at=coalesce(first_opened_at, now())
    where id=${link.id}::uuid
  `;
  // The folio is a fixed-width printed page: a phone shows the whole page
  // zoomed to fit (like a PDF), and the guest can pinch to zoom in.
  const withViewport = link.documentHtml.replace(/<head>/i, `<head><meta charset="utf-8"><meta name="viewport" content="width=${FOLIO_PAGE_WIDTH}"><meta name="robots" content="noindex"><style>body{background:#fff}.doc{margin:0 auto}</style>`);
  const withBar = /<body[^>]*>/i.test(withViewport)
    ? withViewport.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`)
    : `${toolbar}${withViewport}`;
  const html = withBar.replace(/<\/body>/i, `<script>${printScript}</script></body>`);
  return new Response(html.includes(printScript) ? html : `${html}<script>${printScript}</script>`, { status: 200, headers: headers() });
}
