import type { BrowserAdapter } from "../shared/chrome/browserAdapter";
import type { Repository } from "../shared/storage/repository";
import type { Action } from "../features/tab-grouper/planner";
import { pending } from "../features/tab-grouper/planner";
import { parseTabTenant } from "../shared/salesforce/tabTenant";
import { observe, sameObservation } from "../features/tab-grouper/observation";
import type { Intent } from "../shared/models/runtime";
import type { Snapshot } from "../shared/chrome/types";
import { newToken, tokensIn } from "./ownershipRegistry";
import { appearance } from "../features/tab-grouper/appearance";
export class StalePlan extends Error {}
export class Executor {
  constructor(
    private browser: BrowserAdapter,
    private repo: Repository,
    private valid: (windowId: number, generation: number) => boolean,
  ) {}
  async guard(windowId: number, generation: number, revision: number) {
    const settings = await this.repo.freshSettings();
    if (
      !settings.autoGroupingEnabled ||
      settings.revision !== revision ||
      !this.valid(windowId, generation)
    )
      throw new StalePlan();
  }
  async execute(action: Action, snapshot: Snapshot, generation: number) {
    const known = new Set(this.repo.runtime.intents.map((i) => i.operationId));
    try {
      await this.perform(action, snapshot, generation);
    } catch (error) {
      if (error instanceof StalePlan) {
        // A stale guard before the API is proof this intent was not submitted.
        // It must never legitimize a later user move into the planned target.
        this.repo.runtime.intents = this.repo.runtime.intents.filter(
          (i) => known.has(i.operationId) || i.phase !== "prepared",
        );
        await this.repo.saveRuntime();
      }
      throw error;
    }
  }
  private async perform(
    action: Action,
    snapshot: Snapshot,
    generation: number,
  ) {
    const revision = this.repo.settings.revision;
    await this.guard(action.windowId, generation, revision);
    const tabs = await Promise.all(
      action.tabIds.map((id) => this.browser.tab(id)),
    );
    for (const tab of tabs) {
      const before = snapshot.tabs.find((t) => t.id === tab.id);
      if (
        !before ||
        !sameObservation(observe(tab), observe(before)) ||
        tab.url !== before.url ||
        tab.pinned ||
        tab.incognito ||
        pending(tab) ||
        (tab.splitViewId !== undefined && tab.splitViewId !== -1) ||
        this.repo.runtime.overrides[tab.id!]
      )
        throw new StalePlan();
      const p = parseTabTenant(tab.url);
      if (action.kind === "create" || action.kind === "join") {
        if (
          p.kind !== "supported" ||
          p.tenantKey !== action.tenantKey ||
          this.repo.settings.excludedTenants.includes(p.tenantKey)
        )
          throw new StalePlan();
      }
      if (tab.groupId !== -1) {
        await this.validateGroup(tab.groupId, snapshot);
      }
    }
    if (action.groupId !== undefined)
      await this.validateGroup(action.groupId, snapshot);
    // Expand with its own journal, before an active tab joins a collapsed group.
    if (
      action.kind === "join" &&
      action.groupId !== undefined &&
      tabs.some((t) => t.active)
    ) {
      const target = await this.browser.group(action.groupId);
      if (target.collapsed) {
        await this.metadata(
          action.groupId,
          { collapsed: false },
          action,
          generation,
          revision,
          snapshot,
        );
      }
    }
    let token: string | undefined;
    if (action.kind === "create") {
      let registration = this.repo.ownership.find(
        (r) => r.tenantKey === action.tenantKey && r.status === "active",
      );
      if (!registration) {
        registration = {
          token: newToken(),
          tenantKey: action.tenantKey!,
          status: "active",
          createdAt: Date.now(),
        };
        this.repo.ownership.push(registration);
        await this.repo.saveOwnership();
      }
      token = registration.token;
    }
    const intent: Intent = {
      operationId: crypto.randomUUID(),
      kind: action.kind === "expand" ? "metadata" : action.kind,
      windowId: action.windowId,
      tenantKey: action.tenantKey,
      token,
      tabIds: action.tabIds,
      targetGroupId: action.groupId,
      expectedBefore: Object.fromEntries(tabs.map((t) => [t.id!, observe(t)])),
      settingsRevision: revision,
      phase: "prepared",
      expiresAt: Date.now() + 60_000,
      ...(token
        ? {
            appearance: appearance(action.tenantKey!, this.repo.settings),
          }
        : {}),
    };
    this.repo.runtime.intents.push(intent);
    await this.repo.saveRuntime();
    await this.guard(action.windowId, generation, revision);
    // After the final durable await, reread affected tabs. Chrome has no atomic
    // conditional mutation; conflicting results are protected in reconciliation.
    for (const before of tabs) {
      const current = await this.browser.tab(before.id!);
      if (
        current.url !== before.url ||
        current.pendingUrl !== before.pendingUrl ||
        current.incognito ||
        current.pinned ||
        (current.splitViewId !== undefined && current.splitViewId !== -1) ||
        current.active !== before.active ||
        this.repo.runtime.overrides[current.id!] ||
        !sameObservation(observe(current), observe(before))
      )
        throw new StalePlan();
    }
    for (const groupId of new Set(
      tabs.filter((t) => t.groupId !== -1).map((t) => t.groupId),
    ))
      await this.validateGroup(groupId, snapshot);
    if (action.groupId !== undefined)
      await this.validateGroup(action.groupId, snapshot);
    await this.guard(action.windowId, generation, revision);
    if (action.kind === "create")
      intent.targetGroupId = await this.browser.create(
        action.tabIds,
        action.windowId,
      );
    if (action.kind === "join")
      await this.browser.join(action.tabIds, action.groupId!);
    if (action.kind === "ungroup") await this.browser.ungroup(action.tabIds);
    if (action.kind === "expand")
      await this.browser.metadata(action.groupId!, { collapsed: false });
    intent.phase = "applied";
    await this.repo.saveRuntime();
    // A generation change from our own event echo is normal. Creation completion
    // uses the journal and fresh browser facts, never stale event payloads.
    if (action.kind === "create") {
      const completed = await this.finishCreation(intent);
      if (!completed) return;
    }
    const actual = await Promise.all(
      action.tabIds.map((id) => this.browser.tab(id).catch(() => undefined)),
    );
    for (const tab of actual) {
      if (tab?.id !== undefined) {
        const expected = action.kind === "ungroup" ? -1 : intent.targetGroupId;
        if (
          action.kind !== "expand" &&
          tab.groupId !== expected &&
          !tab.pinned
        ) {
          this.repo.runtime.overrides[tab.id] = {
            tabId: tab.id,
            reason: tab.groupId === -1 ? "manual-ungroup" : "manual-regroup",
            createdAt: Date.now(),
          };
        }
        this.repo.runtime.observations[tab.id] = observe(
          tab,
          this.repo.runtime.observations[tab.id],
        );
      }
    }
    intent.phase = "verified";
    await this.repo.saveRuntime();
    this.repo.runtime.intents = this.repo.runtime.intents.filter(
      (i) => i.operationId !== intent.operationId,
    );
    await this.repo.saveRuntime();
  }
  private async validateGroup(groupId: number, snapshot: Snapshot) {
    const binding = this.repo.runtime.bindings.find(
      (b) => b.groupId === groupId && b.status === "verified",
    );
    const group = await this.browser.group(groupId);
    if (
      !binding ||
      group.shared ||
      group.windowId !== binding.windowId ||
      group.title !== snapshot.groups.find((g) => g.id === groupId)?.title ||
      tokensIn(group.title).length > 1 ||
      (tokensIn(group.title).length === 1 &&
        !tokensIn(group.title).includes(binding.token)) ||
      !this.repo.ownership.some(
        (r) => r.token === binding.token && r.status === "active",
      )
    )
      throw new StalePlan();
    const members = (await this.browser.snapshot()).tabs.filter(
      (t) => t.groupId === groupId,
    );
    if (
      members.some((t) => t.splitViewId !== undefined && t.splitViewId !== -1)
    )
      throw new StalePlan();
    const currentGroups = (await this.browser.snapshot()).groups;
    const peers = currentGroups.filter(
      (g) =>
        g.windowId === binding.windowId &&
        tokensIn(g.title).includes(binding.token),
    );
    if (
      peers.length > 1 &&
      !peers.every((g) =>
        this.repo.runtime.bindings.some(
          (b) =>
            b.groupId === g.id &&
            b.token === binding.token &&
            b.status === "verified" &&
            b.tenantKey === binding.tenantKey,
        ),
      )
    )
      throw new StalePlan();
    for (const tab of members) {
      const previous = snapshot.tabs.find(
        (t) => t.id === tab.id && t.groupId === groupId,
      );
      const p = parseTabTenant(tab.url);
      if (
        !previous &&
        (p.kind !== "supported" || p.tenantKey !== binding.tenantKey)
      )
        throw new StalePlan();
      if (previous && previous.url !== tab.url) throw new StalePlan();
    }
  }
  private async metadata(
    id: number,
    properties: chrome.tabGroups.UpdateProperties,
    action: Action,
    generation: number,
    revision: number,
    snapshot: Snapshot,
  ) {
    const intent: Intent = {
      operationId: crypto.randomUUID(),
      kind: "metadata",
      windowId: action.windowId,
      tenantKey: action.tenantKey,
      tabIds: [],
      targetGroupId: id,
      expectedBefore: {},
      settingsRevision: revision,
      phase: "prepared",
      expiresAt: Date.now() + 60_000,
    };
    this.repo.runtime.intents.push(intent);
    await this.repo.saveRuntime();
    await this.guard(action.windowId, generation, revision);
    await this.validateGroup(id, snapshot);
    await this.browser.metadata(id, properties);
    intent.phase = "verified";
    await this.repo.saveRuntime();
  }
  private async creationCandidate(intent: Intent) {
    if (intent.expiresAt < Date.now()) return;
    const snapshot = await this.browser.snapshot();
    if (
      !snapshot.windows.some(
        (w) => w.id === intent.windowId && w.type === "normal" && !w.incognito,
      )
    )
      return;
    if (
      !intent.token ||
      !intent.tenantKey ||
      !intent.appearance ||
      !this.repo.ownership.some(
        (r) => r.token === intent.token && r.status === "active",
      )
    )
      return;
    const matches = snapshot.groups.filter(
      (g) =>
        g.windowId === intent.windowId &&
        !g.shared &&
        snapshot.tabs.filter((t) => t.groupId === g.id).length ===
          intent.tabIds.length &&
        intent.tabIds.every((id) =>
          snapshot.tabs.some((t) => t.id === id && t.groupId === g.id),
        ),
    );
    const group = matches.length === 1 ? matches[0] : undefined;
    if (
      !group ||
      (intent.targetGroupId !== undefined && group.id !== intent.targetGroupId)
    )
      return;
    const markers = tokensIn(group.title);
    if (
      markers.length > 1 ||
      (group.title &&
        group.title !== intent.appearance.title &&
        !(markers.length === 1 && markers[0] === intent.token))
    )
      return;
    if (
      snapshot.groups.some(
        (g) =>
          g.id !== group.id &&
          g.windowId === group.windowId &&
          tokensIn(g.title).includes(intent.token!),
      )
    )
      return;
    for (const id of intent.tabIds) {
      const tab = snapshot.tabs.find((t) => t.id === id)!;
      const before = intent.expectedBefore[id],
        parsed = parseTabTenant(tab.url);
      if (
        !before ||
        pending(tab) ||
        tab.pinned ||
        tab.incognito ||
        (tab.splitViewId !== undefined && tab.splitViewId !== -1) ||
        this.repo.runtime.overrides[id] ||
        parsed.kind !== "supported" ||
        parsed.tenantKey !== intent.tenantKey ||
        observe(tab).host !== before.host ||
        tab.windowId !== intent.windowId
      )
        return;
    }
    return group;
  }
  async finishCreation(intent: Intent) {
    if (intent.appearance && intent.tenantKey)
      intent.appearance.title = appearance(
        intent.tenantKey,
        this.repo.settings,
      ).title;
    let group = await this.creationCandidate(intent);
    if (!group) return false;
    const settings = await this.repo.freshSettings();
    if (
      !settings.autoGroupingEnabled ||
      settings.revision !== intent.settingsRevision ||
      settings.excludedTenants.includes(intent.tenantKey!)
    )
      return false;
    intent.targetGroupId = group.id;
    await this.repo.saveRuntime();
    if (group.title !== intent.appearance!.title) {
      const latest = await this.repo.freshSettings();
      if (
        !latest.autoGroupingEnabled ||
        latest.revision !== intent.settingsRevision ||
        latest.excludedTenants.includes(intent.tenantKey!)
      )
        return false;
      // Storage awaits are user-interaction opportunities: verify the group,
      // members and window again immediately before assigning ownership.
      group = await this.creationCandidate(intent);
      if (!group) return false;
      if (group.title !== intent.appearance!.title)
        await this.browser.metadata(group.id, intent.appearance!);
    }
    group = await this.creationCandidate(intent);
    if (!group) return false;
    this.repo.runtime.bindings = this.repo.runtime.bindings.filter(
      (b) => b.groupId !== group.id,
    );
    this.repo.runtime.bindings.push({
      groupId: group.id,
      windowId: intent.windowId,
      tenantKey: intent.tenantKey!,
      token: intent.token!,
      status: "verified",
      since: Date.now(),
    });
    return true;
  }
  async migrateLegacyTitles(
    snapshot: Snapshot,
    windowId: number,
    generation: number,
  ) {
    for (const binding of this.repo.runtime.bindings) {
      if (
        binding.windowId !== windowId ||
        binding.status !== "verified" ||
        this.repo.settings.excludedTenants.includes(binding.tenantKey)
      )
        continue;
      const group = snapshot.groups.find((g) => g.id === binding.groupId);
      if (!group || !tokensIn(group.title).includes(binding.token)) continue;
      await this.guard(windowId, generation, this.repo.settings.revision);
      await this.validateGroup(group.id, snapshot);
      // The binding was saved before removing the legacy recovery marker.
      await this.browser.metadata(group.id, {
        title: appearance(binding.tenantKey, this.repo.settings).title,
      });
      return true;
    }
    return false;
  }
  async recover() {
    for (const intent of [...this.repo.runtime.intents]) {
      if (intent.kind === "create") {
        const completed = await this.finishCreation(intent);
        if (completed) intent.phase = "verified";
        if (!completed) {
          // A possibly created, unmarked group stays protected. Do not retry the
          // old operation against a new set of candidates.
          const s = await this.browser.snapshot();
          if (
            intent.tabIds.some((id) =>
              s.tabs.some((t) => t.id === id && t.groupId !== -1),
            )
          ) {
            this.repo.runtime.reasons["ambiguous-journal"] =
              (this.repo.runtime.reasons["ambiguous-journal"] ?? 0) + 1;
            this.repo.runtime.degraded = "ambiguous-journal";
          }
        }
      }
      // Preserve expected membership across the recovery snapshot so an API
      // committed before worker termination is not attributed to the user.
    }
  }
}
