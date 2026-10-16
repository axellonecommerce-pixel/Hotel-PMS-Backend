import { NextResponse, type NextRequest } from "next/server";

function allowedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = (process.env.PMS_FRONTEND_ORIGINS ?? "http://localhost:4000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

export function proxy(request: NextRequest) {
  const origin = allowedOrigin(request);
  const response = request.method === "OPTIONS" ? new NextResponse(null, { status: 204 }) : NextResponse.next();
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Property-Id");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

export const config = { matcher: "/api/:path*" };
