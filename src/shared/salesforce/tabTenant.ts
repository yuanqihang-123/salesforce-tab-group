import { parseSalesforceUrl, type ParsedSalesforceUrl } from "./urlParser";

// Store releases plus the Inspector installation observed in this profile.
const inspectorIds = new Set([
  "aodjmnfhjibkcdimpodiifdjnnncaafh",
  "hpijlohoihegkfehhibggnkbjhoemldh",
  "nobhcglociplekefjfpeaajecldpjlmn",
]);

/** Group Inspector tools by their explicit host without making them switcher origins. */
export function parseTabTenant(input?: string): ParsedSalesforceUrl {
  const direct = parseSalesforceUrl(input);
  if (!input) return direct;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return direct;
  }
  if (
    url.protocol !== "chrome-extension:" ||
    !inspectorIds.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/[a-z][a-z0-9-]*\.html$/.test(url.pathname)
  )
    return direct;
  const hosts = url.searchParams.getAll("host");
  // A single bare hostname only: no scheme, credentials, port, path or redirect.
  if (hosts.length !== 1 || !/^[a-z0-9.-]+$/i.test(hosts[0]!)) return direct;
  const tenant = parseSalesforceUrl(`https://${hosts[0]}/`);
  return tenant.kind === "supported" ? tenant : direct;
}
