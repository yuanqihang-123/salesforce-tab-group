import type { Observation } from "../../shared/models/runtime";
import type { Tab } from "../../shared/chrome/types";
import { parseTabTenant } from "../../shared/salesforce/tabTenant";
export function observe(
  tab: Tab,
  previous?: Observation,
  now = Date.now(),
): Observation {
  let host = "";
  try {
    host = new URL(tab.url ?? "").hostname;
  } catch {
    /* URL unavailable */
  }
  const p = parseTabTenant(tab.url);
  const identity =
    p.kind === "supported"
      ? p.tenantKey
      : p.kind +
        ("reason" in p ? ":" + p.reason : "") +
        (tab.url === "about:blank" ? ":blank" : "");
  const settled =
    !(tab.pendingUrl && tab.pendingUrl !== tab.url) && tab.status !== "loading";
  return {
    windowId: tab.windowId,
    groupId: tab.groupId,
    host,
    identity,
    pinned: tab.pinned,
    settled,
    stableSince:
      previous?.identity === identity &&
      previous.host === host &&
      previous.settled === settled
        ? previous.stableSince
        : now,
  };
}
export function sameObservation(a: Observation, b: Observation) {
  return (
    a.windowId === b.windowId &&
    a.groupId === b.groupId &&
    a.host === b.host &&
    a.identity === b.identity &&
    a.pinned === b.pinned &&
    a.settled === b.settled
  );
}
