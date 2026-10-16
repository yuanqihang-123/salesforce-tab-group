import type { Surface, TenantKey } from "../../src/shared/salesforce/urlParser";
// Reviewed separately against the exact format tables linked in domain-support.md.
const rows: [string, string][] = [
  ["unpartitioned", "acme"],
  ["sandbox", "acme--pesdev"],
  ["develop", "acme-dev-ed"],
  ["demo", "acme"],
  ["patch", "acme"],
  ["scratch", "acme"],
  ["trailblaze", "acme"],
];
const templates: [Surface, string][] = [
  ["my-domain", "my.salesforce.com"],
  ["lightning", "lightning.force.com"],
  ["setup", "my.salesforce-setup.com"],
  ["experience", "my.site.com"],
];
export const supportedFixtures = rows.flatMap(([partition, label]) =>
  templates.map(([surface, suffix]) => ({
    url: `https://${label}${partition === "unpartitioned" ? "" : "." + partition}.${suffix}/`,
    key: `sf:commercial:${partition}:${label}` as TenantKey,
    surface,
  })),
);
export const negativeFixtures = [
  "https://acme.my.site.com.evil.example",
  "https://salesforce.com.evil.example",
  "https://salesforce.com@evil.example",
  "https://evil.example/salesforce.com",
  "https://evil.acme.lightning.force.com",
  "http://acme.lightning.force.com",
  "https://user:password@acme.my.salesforce.com",
  "https://acme.my.salesforce.com:8443",
  "https://login.salesforce.com",
  "https://test.salesforce.com",
  "https://na123.salesforce.com",
  "https://acme--dev.my.salesforce.com",
  "https://acme--c.vf.force.com",
  "https://acme.file.force.com",
  "https://acme.force.com/site",
  "https://partners.example.com",
  "https://acme.sandbox.lightning.force.com",
  "https://acme--.sandbox.my.salesforce.com",
  "https://-acme.my.salesforce.com",
  "https://acme_.my.salesforce.com",
  "https://xn--acme-9za.my.salesforce.com",
  "https://阿克米.my.salesforce.com",
  "https://acme.future.lightning.force.com",
  "https://acme.my.salesforce.mil",
  "garbage",
  "about:blank",
  "chrome-error://chromewebdata/",
];
