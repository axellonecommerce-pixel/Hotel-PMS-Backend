const hostedPreviewSuffixes = [".netlify.app", ".vercel.app"];

function httpsOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function frontendOrigins(value: string | undefined) {
  return (value ?? "").split(",").map((candidate) => httpsOrigin(candidate)).filter((candidate): candidate is string => Boolean(candidate));
}

function isBrandedOrigin(origin: string) {
  const hostname = new URL(origin).hostname;
  return !hostedPreviewSuffixes.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Public loyalty cards live behind the branded frontend proxy. Keeping this
 * choice in one place prevents QR codes and newly issued links from exposing
 * a Vercel deployment hostname.
 */
export function publicCardOrigin(requestUrl: string, configuredOrigin = process.env.PMS_PUBLIC_CARD_ORIGIN, allowedFrontendOrigins = process.env.PMS_FRONTEND_ORIGINS) {
  const configured = httpsOrigin(configuredOrigin);
  if (configured) return configured;

  const allowed = frontendOrigins(allowedFrontendOrigins);
  return allowed.find(isBrandedOrigin) ?? allowed[0] ?? new URL(requestUrl).origin;
}

export function publicCardUrl(requestUrl: string, token: string, configuredOrigin = process.env.PMS_PUBLIC_CARD_ORIGIN, allowedFrontendOrigins = process.env.PMS_FRONTEND_ORIGINS) {
  return new URL(`/l/${encodeURIComponent(token)}`, publicCardOrigin(requestUrl, configuredOrigin, allowedFrontendOrigins)).toString();
}
