export const partitions = [
  "unpartitioned",
  "sandbox",
  "develop",
  "demo",
  "patch",
  "scratch",
  "trailblaze",
] as const;
export type Partition = (typeof partitions)[number];
export type TenantKey = `sf:commercial:${Partition}:${string}`;
export type Surface = "my-domain" | "lightning" | "setup" | "experience";
export type ParsedSalesforceUrl =
  | {
      kind: "supported";
      tenantKey: TenantKey;
      domainLabel: string;
      partition: Partition;
      surface: Surface;
      hostname: string;
    }
  | { kind: "unsupported-salesforce"; reason: string }
  | { kind: "non-salesforce" }
  | { kind: "unavailable"; reason: string };
// Each enabled partition/surface is backed by docs/domain-support.md and fixtures.
export const suffixes: Record<Surface, string> = {
  "my-domain": "my.salesforce.com",
  lightning: "lightning.force.com",
  setup: "my.salesforce-setup.com",
  experience: "my.site.com",
};
export const verifiedSurfaces: Record<Partition, readonly Surface[]> = {
  unpartitioned: ["my-domain", "lightning", "setup", "experience"],
  sandbox: ["my-domain", "lightning", "setup", "experience"],
  develop: ["my-domain", "lightning", "setup", "experience"],
  demo: ["my-domain", "lightning", "setup", "experience"],
  patch: ["my-domain", "lightning", "setup", "experience"],
  scratch: ["my-domain", "lightning", "setup", "experience"],
  trailblaze: ["my-domain", "lightning", "setup", "experience"],
};
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function validLabel(label: string): boolean {
  return labelPattern.test(label) && !label.startsWith("xn--");
}
export function parseSalesforceUrl(input?: string): ParsedSalesforceUrl {
  if (!input) return { kind: "unavailable", reason: "missing-url" };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "unavailable", reason: "invalid-url" };
  }
  let hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  const related = [
    "salesforce.com",
    "salesforce-setup.com",
    "force.com",
    "site.com",
    "salesforce.mil",
    "salesforce.cn",
  ].some((s) => hostname === s || hostname.endsWith("." + s));
  const unsupported = (reason: string): ParsedSalesforceUrl =>
    related
      ? { kind: "unsupported-salesforce", reason }
      : { kind: "non-salesforce" };
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return unsupported("unsafe-url");
  for (const [surface, suffix] of Object.entries(suffixes) as [
    Surface,
    string,
  ][]) {
    if (!hostname.endsWith("." + suffix)) continue;
    const labels = hostname.slice(0, -suffix.length - 1).split(".");
    const domainLabel = labels[0] ?? "";
    if (!validLabel(domainLabel)) return unsupported("invalid-domain-label");
    let partition: Partition = "unpartitioned";
    if (
      labels.length === 2 &&
      partitions.some((p) => p === labels[1] && p !== "unpartitioned")
    )
      partition = labels[1] as Partition;
    else if (labels.length !== 1)
      return unsupported("unknown-partition-or-subdomain");
    if (
      partition === "sandbox" &&
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
        domainLabel,
      )
    )
      return unsupported("invalid-sandbox-label");
    if (partition === "unpartitioned" && domainLabel.includes("--"))
      return unsupported("ambiguous-legacy-sandbox");
    if (!verifiedSurfaces[partition].includes(surface))
      return unsupported("unverified-domain-template");
    return {
      kind: "supported",
      tenantKey: `sf:commercial:${partition}:${domainLabel}`,
      domainLabel,
      partition,
      surface,
      hostname,
    };
  }
  if (["about:", "chrome-error:", "chrome:"].includes(url.protocol))
    return { kind: "unavailable", reason: "transient-or-internal" };
  return unsupported("unsupported-domain");
}
export function isTenantKey(value: string): value is TenantKey {
  const match = /^sf:commercial:([^:]+):([^:]+)$/.exec(value);
  if (
    !match ||
    !partitions.some((p) => p === match[1]) ||
    !validLabel(match[2] ?? "")
  )
    return false;
  const partition = match[1],
    label = match[2];
  return (
    parseSalesforceUrl(
      `https://${label}${partition === "unpartitioned" ? "" : "." + partition}.my.salesforce.com`,
    ).kind === "supported"
  );
}
