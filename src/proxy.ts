import { NextResponse, type NextRequest } from "next/server";

function allowedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  const allowed = (process.env.PMS_FRONTEND_ORIGINS ?? "http://localhost:4000")
    .split(",")
    // Browsers send Origin without a trailing slash, while hosting dashboards
    // commonly save URLs with one. Normalize both sides so a legitimate
    // Netlify frontend is not rejected by CORS before it can save settings.
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

/**
 * Old copies of the PMS that must never reach this API again, whatever
 * PMS_FRONTEND_ORIGINS still lists: they run old code without today's
 * protections (two-step sign-in screen, content security policy).
 */
const RETIRED_FRONTEND_ORIGINS = new Set(["https://lustrous-arithmetic-baa66a.netlify.app"]);

export function proxy(request: NextRequest) {
  const requestOrigin = request.headers.get("origin")?.replace(/\/$/, "");
  if (requestOrigin && RETIRED_FRONTEND_ORIGINS.has(requestOrigin)) {
    return NextResponse.json(
      { error: "This old InnSeva address is closed. Use https://hotelpmsfrontend.netlify.app." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const origin = allowedOrigin(request);
  const response = request.method === "OPTIONS" ? new NextResponse(null, { status: 204 }) : NextResponse.next();
  // Every API answer is private to the signed-in hotel: never cache it in a
  // shared cache, and never let a browser guess a different content type.
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Property-Id, Idempotency-Key");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    // Lets the PMS name downloaded files (guest data, backups) as the server does.
    response.headers.set("Access-Control-Expose-Headers", "Content-Disposition, Idempotent-Replayed");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

export const config = { matcher: "/api/:path*" };
