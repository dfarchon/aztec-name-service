import routes from "./app-routes.json";

/**
 * Hash pages that also answer at a plain path, so a typed or shared /docs/pricing opens #/docs/pricing.
 * The API Worker redirects these paths; a separately hosted site rewrites them to index.html and the app converts them.
 */
export const APP_ROUTES: readonly string[] = routes;

/** The hash route (`#/docs/pricing`) for a plain app path, or undefined when the path is not one. */
export function appRouteHash(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (
    !parts.length ||
    !APP_ROUTES.includes(parts[0]) ||
    parts.length > 2 ||
    !parts.every((part) => /^[A-Za-z0-9._-]{1,64}$/.test(part))
  )
    return;
  return `#/${parts.join("/")}`;
}
