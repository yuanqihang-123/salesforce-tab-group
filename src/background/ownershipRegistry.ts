import type { Snapshot } from "../shared/chrome/types";
import type { Runtime, Registration, Binding } from "../shared/models/runtime";
import { parseTabTenant } from "../shared/salesforce/tabTenant";
import { sameObservation } from "../features/tab-grouper/observation";
import { excludeTab } from "../features/tab-grouper/userOverrides";
export function tokensIn(title = ""): string[] {
  return [...title.matchAll(/\[SFN:([A-Za-z0-9_-]{16})\]/g)].map((m) => m[1]!);
}
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}
export interface OwnershipResult {
  bindings: Binding[];
  released: Set<string>;
  releaseReasons: Map<string, string>;
  reasons: Record<string, number>;
}
export function resolveOwnership(
  snapshot: Snapshot,
  runtime: Runtime,
  registrations: Registration[],
  now = Date.now(),
  revision?: number,
): OwnershipResult {
  const released = new Set<string>();
  const releaseReasons = new Map<string, string>();
  const release = (token: string, reason: string) => {
    released.add(token);
    releaseReasons.set(token, reason);
  };
  const reasons: Record<string, number> = {};
  const count = (r: string) => {
    reasons[r] = (reasons[r] ?? 0) + 1;
  };
  const candidates: Binding[] = [];
  const eligibleWindows = new Set(
    snapshot.windows
      .filter((w) => w.type === "normal" && !w.incognito)
      .map((w) => w.id),
  );
  for (const group of snapshot.groups) {
    if (!eligibleWindows.has(group.windowId)) continue;
    const tokens = tokensIn(group.title);
    const bound = runtime.bindings.find((b) => b.groupId === group.id);
    // Titles are presentation only. Legacy markers are used solely to migrate
    // existing groups when their session binding is unavailable.
    if (
      tokens.length > 1 ||
      (tokens.length === 1 && bound && tokens[0] !== bound.token)
    ) {
      for (const token of tokens)
        if (
          registrations.some((r) => r.token === token && r.status === "active")
        )
          release(token, "token-conflict");
      continue;
    }
    const registration = registrations.find(
      (r) => r.token === (bound?.token ?? tokens[0]),
    );
    if (!registration || released.has(registration.token)) continue;
    if (registration.status === "released") {
      count(registration.releaseReason ?? "released-group");
      continue;
    }
    const peers = snapshot.groups.filter(
      (g) =>
        g.windowId === group.windowId &&
        tokensIn(g.title).includes(registration.token),
    );
    if (
      peers.length > 1 &&
      !peers.every((g) =>
        runtime.bindings.some(
          (b) => b.groupId === g.id && b.token === registration.token,
        ),
      )
    ) {
      release(registration.token, "token-conflict");
      count("token-conflict");
      continue;
    }
    if (group.shared) {
      release(registration.token, "shared-group");
      count("shared-group");
      continue;
    }
    const members = snapshot.tabs.filter((t) => t.groupId === group.id);
    if (!members.length) continue;
    const old = runtime.bindings.find(
      (b) => b.groupId === group.id && b.token === registration.token,
    );
    const hasSplit = members.some(
      (t) => t.splitViewId !== undefined && t.splitViewId !== -1,
    );
    if (hasSplit) count("split-view");
    let uncertain = hasSplit,
      conflict = false;
    for (const tab of members) {
      const p = parseTabTenant(tab.url);
      if (p.kind === "supported" && p.tenantKey === registration.tenantKey)
        continue;
      // A previously observed member may navigate out; a newly inserted foreign
      // member is user intent. Cold recovery never inherits warm-session trust.
      const prev =
        tab.id === undefined ? undefined : runtime.observations[tab.id];
      if (old?.status === "verified" && prev?.groupId === group.id) continue;
      if (
        p.kind === "unavailable" ||
        (tab.pendingUrl && tab.pendingUrl !== tab.url)
      )
        uncertain = true;
      else conflict = true;
    }
    if (conflict) {
      release(registration.token, "mixed-membership");
      count("mixed-membership");
      continue;
    }
    const since = old?.since ?? now;
    if (uncertain)
      count(now - since >= 60_000 ? "recovery-timeout" : "recovering");
    candidates.push({
      windowId: group.windowId,
      groupId: group.id,
      tenantKey: registration.tenantKey,
      token: registration.token,
      status: uncertain ? "recovering" : "verified",
      since,
    });
  }
  const bindings = candidates.filter((b) => !released.has(b.token));
  // Expected operations are persisted before Chrome calls, including early echoes.
  for (const tab of snapshot.tabs) {
    if (tab.id === undefined) continue;
    const prev = runtime.observations[tab.id];
    if (
      !prev ||
      prev.groupId === tab.groupId ||
      prev.groupId === -1 ||
      tab.pinned ||
      prev.pinned
    )
      continue;
    const wasOwned = runtime.bindings.some((b) => b.groupId === prev.groupId);
    if (!wasOwned) continue;
    const expected = runtime.intents.some(
      (i) =>
        i.expiresAt >= now &&
        i.tabIds.includes(tab.id!) &&
        (revision === undefined || i.settingsRevision === revision) &&
        !!i.expectedBefore[tab.id!] &&
        sameObservation(i.expectedBefore[tab.id!]!, prev) &&
        (i.kind === "ungroup"
          ? tab.groupId === -1
          : i.targetGroupId !== undefined && i.targetGroupId === tab.groupId),
    );
    const wholeGroupMove =
      bindings.some(
        (b) => b.groupId === tab.groupId && b.tenantKey === prev.identity,
      ) && prev.windowId !== tab.windowId;
    if (expected || wholeGroupMove) continue;
    excludeTab(
      runtime,
      tab.id,
      tab.groupId === -1 ? "manual-ungroup" : "manual-regroup",
    );
    const target = bindings.find((b) => b.groupId === tab.groupId);
    if (target && prev.identity !== target.tenantKey) {
      release(target.token, "manual-regroup");
      count("manual-regroup");
    }
  }
  return {
    bindings: bindings.filter((b) => !released.has(b.token)),
    released,
    releaseReasons,
    reasons,
  };
}
