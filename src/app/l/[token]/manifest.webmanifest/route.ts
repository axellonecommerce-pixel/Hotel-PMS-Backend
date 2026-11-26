export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Not found", { status: 404 });
  return Response.json({
    name: "InnSeva Rewards",
    short_name: "Rewards",
    id: `/l/${token}`,
    start_url: `/l/${token}`,
    scope: `/l/${token}`,
    display: "standalone",
    background_color: "#eef6fd",
    theme_color: "#092b4c",
    icons: [{ src: "/brand/innseva-logo.png", sizes: "any", type: "image/png", purpose: "any maskable" }],
  }, { headers: { "Cache-Control": "private, max-age=300", "Content-Type": "application/manifest+json" } });
}
