import type { Binding, Runtime } from "../../shared/models/runtime";
import type { Settings } from "../../shared/models/settings";
import type { Snapshot, Tab } from "../../shared/chrome/types";
import type { TenantKey } from "../../shared/salesforce/urlParser";
import { parseTabTenant } from "../../shared/salesforce/tabTenant";
export type Action = {
  kind: "create" | "join" | "ungroup" | "expand";
  windowId: number;
  tabIds: number[];
  tenantKey?: TenantKey;
  groupId?: number;
};
export interface Plan {
  actions: Action[];
  reasons: Record<string, number>;
}
export function pending(tab: Tab): boolean {
  return !!tab.pendingUrl && tab.pendingUrl !== tab.url;
}
export function plan(
  snapshot: Snapshot,
  settings: Settings,
  runtime: Runtime,
  bindings: Binding[],
  now = Date.now(),
  detached = new Set<number>(),
): Plan {
  const actions: Action[] = [],
    reasons: Record<string, number> = {};
  const count = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };
  if (!settings.autoGroupingEnabled) return { actions, reasons };
  const eligibleWindows = new Set(
    snapshot.windows
      .filter((w) => w.type === "normal" && !w.incognito)
      .map((w) => w.id),
  );
  const batches = new Map<string, Action>();
  for (const tab of snapshot.tabs) {
    if (tab.id === undefined) continue;
    const owned = bindings.find(
      (b) => b.groupId === tab.groupId && b.windowId === tab.windowId,
    );
    if (!eligibleWindows.has(tab.windowId) || tab.incognito) {
      count("excluded-window");
      continue;
    }
    if (detached.has(tab.id)) {
      count("detached");
      continue;
    }
    if (tab.pinned) {
      count("pinned");
      continue;
    }
    if (tab.splitViewId !== undefined && tab.splitViewId !== -1) {
      count("split-view");
      continue;
    }
    if (tab.groupId !== -1 && !owned) {
      count(
        snapshot.groups.find((g) => g.id === tab.groupId)?.shared
          ? "shared-group"
          : "protected-group",
      );
      continue;
    }
    if (runtime.overrides[tab.id]) {
      count("manual-override");
      continue;
    }
    if (owned?.status === "recovering") {
      count("recovering");
      continue;
    }
    if (pending(tab)) {
      count("pending-navigation");
      continue;
    }
    const parsed = parseTabTenant(tab.url);
    if (parsed.kind === "supported") {
      if (
        settings.excludedTenants.includes(parsed.tenantKey) ||
        (owned && settings.excludedTenants.includes(owned.tenantKey))
      ) {
        count("excluded-tenant");
        continue;
      }
      const matching = bindings.filter(
        (b) => b.windowId === tab.windowId && b.tenantKey === parsed.tenantKey,
      );
      const target = matching.find((b) => b.status === "verified");
      if (!target && matching.length) {
        count("recovering");
        continue;
      }
      if (target?.groupId === tab.groupId) {
        if (
          tab.active &&
          snapshot.groups.find((g) => g.id === target.groupId)?.collapsed
        )
          actions.push({
            kind: "expand",
            windowId: tab.windowId,
            tabIds: [tab.id],
            groupId: target.groupId,
            tenantKey: parsed.tenantKey,
          });
        continue;
      }
      const key = `${tab.windowId}/${parsed.tenantKey}`;
      const batch = batches.get(key) ?? {
        kind: target ? "join" : "create",
        windowId: tab.windowId,
        tabIds: [],
        tenantKey: parsed.tenantKey,
        groupId: target?.groupId,
      };
      batch.tabIds.push(tab.id);
      batches.set(key, batch);
      continue;
    }
    if (parsed.kind !== "non-salesforce")
      count(parsed.kind === "unavailable" ? "url-unavailable" : parsed.reason);
    if (!owned || settings.excludedTenants.includes(owned.tenantKey)) continue;
    const observation = runtime.observations[tab.id];
    const sharedLogin = /^https:\/\/(login|test)\.salesforce\.com\/?/i.test(
      tab.url ?? "",
    );
    const blank = tab.url === "about:blank";
    const stable = observation && now - observation.stableSince >= 10_000;
    if ((blank || sharedLogin) && (!stable || tab.status === "loading")) {
      count("transient-grace");
      continue;
    }
    let web = false;
    try {
      web = ["https:", "http:"].includes(new URL(tab.url ?? "").protocol);
    } catch {
      /* defer */
    }
    if (web || (blank && stable))
      actions.push({
        kind: "ungroup",
        windowId: tab.windowId,
        tabIds: [tab.id],
        groupId: owned.groupId,
        tenantKey: owned.tenantKey,
      });
  }
  actions.push(...batches.values());
  return { actions, reasons };
}
