import type { TenantKey } from "./urlParser";
export function tenantLabel(key: TenantKey): string {
  const domain = key.split(":")[3] ?? key;
  return domain.includes("--") ? domain.slice(domain.indexOf("--") + 2) : domain;
}
export function inferredEnvironment(key: TenantKey): string {
  return key.split(":")[2] === "unpartitioned"
    ? "unknown"
    : (key.split(":")[2] ?? "unknown");
}
