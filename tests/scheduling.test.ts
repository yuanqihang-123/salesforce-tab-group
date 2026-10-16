import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/background/coordinator";
import { Repository } from "../src/shared/storage/repository";
import { FakeChrome, MemoryStorage, tab } from "./fakeChrome";

async function setup(count = 0) {
  const browser = new FakeChrome();
  browser.tabs = Array.from({ length: count }, (_, index) =>
    tab(index + 1, "https://acme.my.salesforce.com"),
  );
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const repo = new Repository(local, session);
  const coordinator = new Coordinator(browser, repo);
  browser.onEcho = (windowId) => coordinator.mark(windowId);
  await coordinator.bootstrapPromise;
  await coordinator.flush();
  return { browser, session, repo, coordinator };
}

describe("coordinator scheduling and retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("stops scheduling and reading once reconciliation is clean", async () => {
    const { browser, coordinator, session, repo } = await setup(1);
    const snapshot = vi.spyOn(browser, "snapshot");
    coordinator.mark(1);
    await coordinator.serial(async () => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.runtime.dirty).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const snapshots = snapshot.mock.calls.length;
    const writes = session.writes;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).toHaveBeenCalledTimes(snapshots);
    expect(session.writes).toBe(writes);
  });

  it("waits 250ms, 1s, and 3s between retries without polling", async () => {
    const { browser, coordinator, repo } = await setup();
    browser.tabs.push(tab(1, "https://acme.my.salesforce.com"));
    let attempts = 0;
    browser.boundary = (name) => {
      if (name === "create.before") {
        attempts++;
        throw new Error("Tabs cannot be edited while dragging");
      }
    };
    const snapshot = vi.spyOn(browser, "snapshot");
    coordinator.mark(1);
    await coordinator.serial(async () => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(1);
    for (const [index, delay] of [250, 1000, 3000].entries()) {
      const snapshots = snapshot.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempts).toBe(index + 1);
      expect(snapshot).toHaveBeenCalledTimes(snapshots);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(index + 2);
    }
    expect(repo.runtime.retries[1]?.attempts).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
    const snapshots = snapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(4);
    expect(snapshot).toHaveBeenCalledTimes(snapshots);
    await coordinator.scan();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists closed-window cleanup even when no window can reconcile", async () => {
    const { browser, coordinator, repo, session } = await setup(1);
    repo.runtime.retries[1] = {
      attempts: 2,
      nextEligibleAt: Date.now() + 100_000,
    };
    repo.runtime.dirty = [1];
    await repo.saveRuntime();
    browser.windows = [];
    browser.tabs = [];
    browser.groups = [];
    await coordinator.drain();
    expect(repo.runtime.dirty).toEqual([]);
    expect(repo.runtime.bindings).toEqual([]);
    expect(repo.runtime.retries).toEqual({});
    expect(session.data.runtime).toMatchObject({
      dirty: [],
      bindings: [],
      retries: {},
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains durable backoff for repeated events and resets it for new facts", async () => {
    const { browser, coordinator, repo } = await setup();
    browser.tabs.push(tab(1, "https://acme.my.salesforce.com"));
    let attempts = 0;
    browser.boundary = (name) => {
      if (name === "create.before") {
        attempts++;
        throw new Error("Tabs cannot be edited while dragging");
      }
    };
    coordinator.mark(1);
    await coordinator.serial(async () => {});
    await vi.advanceTimersByTimeAsync(200 + 250 + 1000 + 3000);
    expect(attempts).toBe(4);
    const nextEligibleAt = repo.runtime.retries[1]!.nextEligibleAt;
    for (let i = 0; i < 100; i++) coordinator.mark(1);
    await coordinator.serial(async () => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(4);
    expect(repo.runtime.retries[1]!.nextEligibleAt).toBe(nextEligibleAt);
    expect(vi.getTimerCount()).toBe(0);
    browser.tabs[0]!.url = "https://other.my.salesforce.com";
    coordinator.mark(1);
    await coordinator.serial(async () => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(5);
    expect(repo.runtime.retries[1]?.attempts).toBe(1);
  });

  it("keeps retry eligibility across a worker restart with unchanged facts", async () => {
    const { browser, coordinator, repo, session } = await setup();
    browser.tabs.push(tab(1, "https://acme.my.salesforce.com"));
    browser.boundary = (name) => {
      if (name === "create.before") throw new Error("dragging");
    };
    coordinator.mark(1);
    await coordinator.flush();
    const nextEligibleAt = repo.runtime.retries[1]!.nextEligibleAt;
    const local = new MemoryStorage();
    local.data.settings = structuredClone(repo.settings);
    local.data.ownership = structuredClone(repo.ownership);
    const restartedRepo = new Repository(local, session);
    const restarted = new Coordinator(browser, restartedRepo);
    await restarted.bootstrapPromise;
    await vi.advanceTimersByTimeAsync(200);
    expect(restartedRepo.runtime.retries[1]?.attempts).toBe(1);
    expect(restartedRepo.runtime.retries[1]?.nextEligibleAt).toBe(
      nextEligibleAt,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(restartedRepo.runtime.retries[1]?.attempts).toBe(2);
    await restarted.flush();
  });

  it("fails closed when bootstrap alarm or recovery APIs fail", async () => {
    for (const failAlarm of [true, false]) {
      const browser = new FakeChrome();
      browser.tabs = [tab(1, "https://acme.my.salesforce.com")];
      if (!failAlarm)
        browser.snapshot = async () => {
          throw new Error("browser API unavailable");
        };
      const coordinator = new Coordinator(
        browser,
        new Repository(new MemoryStorage(), new MemoryStorage()),
        async () => {
          if (failAlarm) throw new Error("alarm API unavailable");
        },
      );
      await expect(coordinator.bootstrapPromise).rejects.toThrow();
      expect(coordinator.degraded).toBe("bootstrap-api-error");
      coordinator.mark(1);
      await coordinator.serial(async () => {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(browser.writes).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
