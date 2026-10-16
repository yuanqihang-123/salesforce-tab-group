import type { BrowserAdapter } from "../shared/chrome/browserAdapter";
import { StorageFailure, type Repository } from "../shared/storage/repository";
import { observe } from "../features/tab-grouper/observation";
import { resolveOwnership, tokensIn } from "./ownershipRegistry";
import { Executor, StalePlan } from "./executor";
import { plan } from "../features/tab-grouper/planner";
import { excludeTab } from "../features/tab-grouper/userOverrides";
export class Coordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private generations = new Map<number, number>();
  private pendingWindows = new Set<number>();
  private durableScheduled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstDirtyAt = 0;
  private booted = false;
  private failure: string | undefined;
  private detachedSet = new Set<number>();
  private readonly executor: Executor;
  readonly bootstrapPromise: Promise<void>;
  constructor(
    private readonly browser: BrowserAdapter,
    private readonly repo: Repository,
    private alarmSync: (enabled: boolean) => Promise<void> = async () => {},
  ) {
    this.executor = new Executor(
      browser,
      repo,
      (w, g) => this.generations.get(w) === g && !this.failure,
    );
    this.bootstrapPromise = this.serial(async () => {
      try {
        await repo.load();
        this.booted = true;
        await alarmSync(repo.settings.autoGroupingEnabled);
        await this.executor.recover();
        await this.markAllDurable();
      } catch (error) {
        this.failure =
          error instanceof StorageFailure
            ? "invalid-or-unwritable-storage"
            : "bootstrap-api-error";
        throw error;
      }
    });
    void this.bootstrapPromise.then(() => this.schedule()).catch(() => {});
  }
  get degraded() {
    return this.failure;
  }
  serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch((error) => {
      if (error instanceof StorageFailure)
        this.failure = "invalid-or-unwritable-storage";
    });
    return result;
  }
  private schedule(delay = 200, debounce = true) {
    if (this.timer) clearTimeout(this.timer);
    if (debounce && !this.firstDirtyAt) this.firstDirtyAt = Date.now();
    if (!debounce) this.firstDirtyAt = 0;
    const wait = debounce
      ? Math.max(0, Math.min(delay, 1000 - (Date.now() - this.firstDirtyAt)))
      : Math.max(0, delay);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.firstDirtyAt = 0;
      void this.serial(() => this.drain()).catch(() => {});
    }, wait);
  }
  private scheduleRemaining() {
    if (this.failure) return;
    const now = Date.now();
    const dirty = this.repo.runtime.dirty;
    if (
      dirty.some(
        (id) => (this.repo.runtime.retries[id]?.nextEligibleAt ?? 0) <= now,
      )
    ) {
      this.schedule(0, false);
      return;
    }
    // Only the first three failures retry in this worker. Later failures wait
    // for the compensation alarm or a new browser fact.
    const next = dirty.flatMap((id) => {
      const retry = this.repo.runtime.retries[id];
      return retry && retry.attempts <= 3 ? [retry.nextEligibleAt] : [];
    });
    if (next.length) this.schedule(Math.min(...next) - now, false);
  }
  private retryFingerprint(
    windowId: number,
    snapshot: Awaited<ReturnType<BrowserAdapter["snapshot"]>>,
  ) {
    const tabs = snapshot.tabs
      .filter((tab) => tab.windowId === windowId)
      .sort((a, b) => (a.id ?? -1) - (b.id ?? -1))
      .map((tab) => {
        const fact = observe(tab);
        return [
          tab.id,
          tab.index,
          tab.groupId,
          fact.host,
          fact.identity,
          fact.pinned,
          fact.settled,
          tab.active,
          tab.splitViewId ?? -1,
          tab.discarded,
          this.detachedSet.has(tab.id!),
          !!this.repo.runtime.overrides[tab.id!],
        ];
      });
    const groups = snapshot.groups
      .filter((group) => group.windowId === windowId)
      .sort((a, b) => a.id - b.id)
      .map((group) => [
        group.id,
        tokensIn(group.title),
        !!group.shared,
        group.collapsed,
      ]);
    // This is only current host/identity and structural state, never paths,
    // query strings, page titles, or a history of earlier browser snapshots.
    return JSON.stringify([this.repo.settings.revision, tabs, groups]);
  }
  mark(windowId: number) {
    if (windowId < 0) return;
    this.generations.set(windowId, (this.generations.get(windowId) ?? 0) + 1);
    this.pendingWindows.add(windowId);
    if (!this.durableScheduled) {
      this.durableScheduled = true;
      void this.serial(async () => {
        this.durableScheduled = false;
        if (!this.booted || this.failure) return;
        for (const id of this.pendingWindows) {
          if (!this.repo.runtime.dirty.includes(id))
            this.repo.runtime.dirty.push(id);
        }
        this.pendingWindows.clear();
        await this.repo.saveRuntime();
        this.schedule();
      }).catch(() => {});
    }
  }
  attached(tabId: number, windowId: number) {
    this.detachedSet.delete(tabId);
    this.mark(windowId);
  }
  detached(tabId: number, windowId: number) {
    this.detachedSet.add(tabId);
    this.mark(windowId);
  }
  restoreTab(tabId: number) {
    return this.serial(async () => {
      if (this.failure)
        throw new Error(
          "存储或权限异常，已停止变更。请检查扩展权限和本地数据。",
        );
      delete this.repo.runtime.overrides[tabId];
      await this.repo.saveRuntime();
      const tab = await this.browser.tab(tabId).catch(() => undefined);
      if (tab) this.mark(tab.windowId);
    });
  }
  private async markAllDurable() {
    const snapshot = await this.browser.snapshot();
    for (const w of snapshot.windows) {
      if (w.id !== undefined && !w.incognito && w.type === "normal") {
        if (!this.repo.runtime.dirty.includes(w.id))
          this.repo.runtime.dirty.push(w.id);
        this.generations.set(w.id, (this.generations.get(w.id) ?? 0) + 1);
      }
    }
    await this.repo.saveRuntime();
  }
  async scan() {
    return this.serial(async () => {
      if (!this.booted || this.failure) return;
      await this.repo.freshSettings();
      await this.alarmSync(this.repo.settings.autoGroupingEnabled);
      await this.markAllDurable();
      this.schedule(0);
    });
  }
  async settingsChanged() {
    // Synchronous invalidation occurs before queued storage work.
    for (const [w, g] of this.generations) this.generations.set(w, g + 1);
    return this.scan();
  }
  async replaced(added: number, removed: number) {
    return this.serial(async () => {
      if (!this.booted) return;
      delete this.repo.runtime.observations[removed];
      delete this.repo.runtime.overrides[removed];
      excludeTab(this.repo.runtime, added, "uncertain-replacement");
      await this.repo.saveRuntime();
      const tab = await this.browser.tab(added).catch(() => undefined);
      if (tab) this.mark(tab.windowId);
    });
  }
  async removed(id: number, windowId: number) {
    return this.serial(async () => {
      if (!this.booted) return;
      delete this.repo.runtime.overrides[id];
      delete this.repo.runtime.observations[id];
      this.detachedSet.delete(id);
      await this.repo.saveRuntime();
      this.mark(windowId);
    });
  }
  async drain() {
    if (!this.booted || this.failure) return;
    // Global serialized effects; replan from facts after each mutation.
    let budget = 1;
    while (budget-- > 0) {
      await this.repo.freshSettings();
      const runtime = this.repo.runtime;
      const snapshot = await this.browser.snapshot();
      const windows = new Set(
        snapshot.windows
          .filter((w) => !w.incognito && w.type === "normal")
          .map((w) => w.id),
      );
      const beforeCleanup = JSON.stringify({
        dirty: runtime.dirty,
        bindings: runtime.bindings,
        retries: runtime.retries,
      });
      runtime.dirty = runtime.dirty.filter((w) => windows.has(w));
      runtime.bindings = runtime.bindings.filter(
        (b) =>
          windows.has(b.windowId) ||
          snapshot.groups.some(
            (g) => g.id === b.groupId && windows.has(g.windowId),
          ),
      );
      for (const id of Object.keys(runtime.retries))
        if (!windows.has(Number(id))) delete runtime.retries[Number(id)];
      for (const windowId of runtime.dirty) {
        const retry = runtime.retries[windowId];
        if (!retry) continue;
        const fingerprint = this.retryFingerprint(windowId, snapshot);
        if (retry.fingerprint === undefined) retry.fingerprint = fingerprint;
        else if (retry.fingerprint !== fingerprint)
          delete runtime.retries[windowId];
      }
      if (
        beforeCleanup !==
        JSON.stringify({
          dirty: runtime.dirty,
          bindings: runtime.bindings,
          retries: runtime.retries,
        })
      )
        await this.repo.saveRuntime();
      const id = runtime.dirty.find(
        (w) => (runtime.retries[w]?.nextEligibleAt ?? 0) <= Date.now(),
      );
      if (id === undefined) break;
      const generation = this.generations.get(id) ?? 0;
      this.generations.set(id, generation);
      try {
        const ownership = resolveOwnership(
          snapshot,
          runtime,
          this.repo.ownership,
          Date.now(),
          this.repo.settings.revision,
        );
        if (ownership.released.size) {
          for (const r of this.repo.ownership)
            if (ownership.released.has(r.token)) {
              r.status = "released";
              r.releaseReason =
                ownership.releaseReasons.get(r.token) ?? "released-group";
            }
          await this.repo.saveOwnership();
        }
        runtime.bindings = ownership.bindings;
        const live = new Set(snapshot.tabs.map((t) => String(t.id)));
        for (const key of Object.keys(runtime.overrides))
          if (!live.has(key)) delete runtime.overrides[key];
        for (const key of Object.keys(runtime.observations))
          if (!live.has(key)) delete runtime.observations[key];
        for (const tab of snapshot.tabs)
          if (tab.id !== undefined)
            runtime.observations[tab.id] = observe(
              tab,
              runtime.observations[tab.id],
            );
        const result = plan(
          snapshot,
          this.repo.settings,
          runtime,
          runtime.bindings,
          Date.now(),
          this.detachedSet,
        );
        runtime.reasons = { ...ownership.reasons };
        for (const [key, n] of Object.entries(result.reasons))
          runtime.reasons[key] = (runtime.reasons[key] ?? 0) + n;
        // Once current facts have consumed expected effects, no old intent may
        // authorize a later user operation. Unfinished create journals remain.
        runtime.intents = runtime.intents.filter(
          (i) =>
            i.kind === "create" &&
            i.phase !== "verified" &&
            i.expiresAt > Date.now(),
        );
        runtime.lastScan = Date.now();
        await this.repo.saveRuntime();
        if (!this.repo.settings.autoGroupingEnabled) {
          runtime.dirty = [];
          await this.repo.saveRuntime();
          break;
        }
        if (await this.executor.migrateLegacyTitles(snapshot, id, generation))
          continue;
        const action = result.actions.find((a) => a.windowId === id);
        if (action) {
          await this.executor.execute(action, snapshot, generation);
          continue;
        }
        if (this.generations.get(id) === generation) {
          runtime.dirty = runtime.dirty.filter((w) => w !== id);
          delete runtime.retries[id];
        }
        await this.repo.saveRuntime();
      } catch (error) {
        if (error instanceof StorageFailure) {
          this.failure = "invalid-or-unwritable-storage";
          throw error;
        }
        if (error instanceof StalePlan) {
          if (this.generations.get(id) === generation)
            this.generations.set(id, generation + 1);
          continue;
        }
        const retry = runtime.retries[id] ?? { attempts: 0, nextEligibleAt: 0 };
        retry.attempts++;
        retry.nextEligibleAt =
          Date.now() +
          ([250, 1000, 3000][retry.attempts - 1] ??
            Math.min(300_000, 30_000 * 2 ** Math.min(retry.attempts - 4, 4)));
        retry.fingerprint = this.retryFingerprint(id, snapshot);
        runtime.retries[id] = retry;
        runtime.reasons["api-retry"] = 1;
        // Permission/storage failures fail closed, retaining raw saved values.
        if (/permission|storage|quota|schema|ZodError/i.test(String(error))) {
          this.failure = "permission-or-storage-error";
          runtime.degraded = this.failure;
        }
        await this.repo.saveRuntime();
      }
    }
    this.scheduleRemaining();
  }
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.firstDirtyAt = 0;
    await this.queue;
    for (let i = 0; i < 100; i++) {
      await this.serial(() => this.drain());
      await this.queue;
      if (
        !this.repo.runtime?.dirty.some(
          (w) =>
            (this.repo.runtime.retries[w]?.nextEligibleAt ?? 0) <= Date.now(),
        )
      )
        break;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.firstDirtyAt = 0;
  }
}
