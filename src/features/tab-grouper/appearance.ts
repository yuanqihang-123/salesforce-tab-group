import type { Settings } from "../../shared/models/settings";
import type { TenantKey } from "../../shared/salesforce/urlParser";
import { tenantLabel } from "../../shared/salesforce/tenantResolver";
export function appearance(key: TenantKey, settings: Settings) {
  const colors = [
    "blue",
    "cyan",
    "purple",
    "green",
    "orange",
    "pink",
    "yellow",
    "grey",
    "red",
  ] as const;
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const pref = settings.tenantPreferences[key];
  const label = pref?.alias ?? tenantLabel(key);
  return {
    title: label,
    color:
      pref?.environment === "production"
        ? ("red" as const)
        : colors[(hash >>> 0) % colors.length]!,
    collapsed: false,
  };
}
