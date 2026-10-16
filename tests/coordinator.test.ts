import { describe, it, expect } from "vitest";
import { Coordinator } from "../src/background/coordinator";
import { Repository } from "../src/shared/storage/repository";
import { Executor } from "../src/background/executor";
import { runtimeSchema } from "../src/shared/models/runtime";
import { FakeChrome, MemoryStorage, tab, group } from "./fakeChrome";
async function setup(count = 1, echo = true) {
  const f = new FakeChrome();
  f.tabs = Array.from({ length: count }, (_, i) =>
    tab(i + 1, "https://acme.lightning.force.com"),
  );
  const local = new MemoryStorage(),
    session = new MemoryStorage(),
    repo = new Repository(local, session),
    c = new Coordinator(f, repo);
  if (echo) f.onEcho = (w) => c.mark(w);
  await c.bootstrapPromise;
  await c.flush();
  return { f, local, session, repo, c };
}
describe("serialized Chrome reconciliation", () => {
  it("keeps Inspector members owned, joins new tools and survives worker recovery without duplicates", async () => {
    const { f, c, repo, local, session } = await setup(0);
    const host = "casecentral--uatpes.sandbox.my.salesforce.com";
    const inspector = (page: string, target = host) =>
      `chrome-extension://nobhcglociplekefjfpeaajecldpjlmn/${page}.html?host=${target}`;
    f.tabs.push(tab(1, `https://${host}`), tab(2, inspector("data-export")));
    c.mark(1);
    await c.flush();
    const groupId = f.tabs[0]!.groupId;
    expect(f.groups).toHaveLength(1);
    // Reproduce a user opening an Inspector tool directly inside the managed group.
    f.tabs.push(tab(3, inspector("inspect"), 1, { groupId }));
    c.mark(1);
    await c.flush();
    expect(repo.ownership.every((r) => r.status === "active")).toBe(true);
    f.tabs.push(
      tab(4, inspector("data-import")),
      tab(5, `https://${host}/lightning`),
    );
    c.mark(1);
    await c.flush();
    expect(f.tabs.every((t) => t.groupId === groupId)).toBe(true);
    const recovered = new Coordinator(f, new Repository(local, session));
    f.onEcho = (w) => recovered.mark(w);
    await recovered.bootstrapPromise;
    await recovered.flush();
    const writes = f.writes.length;
    recovered.mark(1);
    await recovered.flush();
    expect(f.writes).toHaveLength(writes);
    expect(f.groups).toHaveLength(1);
    // A tool switching host must follow the new tenant.
    f.tabs[1]!.url = inspector(
      "data-export",
      "casecentral--pesqa.sandbox.my.salesforce.com",
    );
    recovered.mark(1);
    await recovered.flush();
    expect(f.groups).toHaveLength(2);
    expect(f.tabs[1]!.groupId).not.toBe(groupId);
    expect(f.groups.find((g) => g.id === f.tabs[1]!.groupId)?.title).toBe(
      "pesqa",
    );
  });

  it("converges 30 simultaneous tabs into one group, then 100 echoes cause zero writes", async () => {
    const { f, c, local } = await setup(30);
    expect(f.groups).toHaveLength(1);
    expect(f.tabs.every((t) => t.groupId === f.groups[0]?.id)).toBe(true);
    expect(f.writes.filter((w) => w.kind === "create")).toHaveLength(1);
    expect(f.tabs[0]?.active).toBe(true);
    const writes = f.writes.length,
      localWrites = local.writes;
    for (let i = 0; i < 100; i++) c.mark(1);
    await c.flush();
    expect(f.writes).toHaveLength(writes);
    expect(local.writes).toBe(localWrites);
  });
  it("scans all windows and respects user-owned groups, pinned and discarded", async () => {
    const f = new FakeChrome();
    f.addWindow(2);
    f.tabs = [
      tab(1, "https://acme.lightning.force.com"),
      tab(2, "https://acme.my.salesforce.com", 2, { discarded: true }),
      tab(3, "https://acme.my.salesforce.com", 1, { pinned: true }),
      tab(4, "https://acme.my.salesforce.com", 1, { groupId: 20 }),
      tab(5, "https://example.com"),
    ];
    f.groups = [group(20, 1, "ACME")];
    const c = new Coordinator(
      f,
      new Repository(new MemoryStorage(), new MemoryStorage()),
    );
    await c.bootstrapPromise;
    await c.flush();
    expect(f.groups).toHaveLength(3);
    expect(f.tabs.find((t) => t.id === 3)?.pinned).toBe(true);
    expect(f.tabs.find((t) => t.id === 4)?.groupId).toBe(20);
    expect(f.tabs.find((t) => t.id === 5)?.groupId).toBe(-1);
    expect(f.tabs.find((t) => t.id === 2)?.discarded).toBe(true);
  });
  it("waits for pending URL, then uses the final committed tenant", async () => {
    const { f, c } = await setup(0);
    f.tabs.push(
      tab(1, undefined, 1, { pendingUrl: "https://acme.my.salesforce.com" }),
    );
    c.mark(1);
    await c.flush();
    expect(f.groups).toEqual([]);
    f.tabs[0]!.url = "about:blank";
    c.mark(1);
    await c.flush();
    expect(f.groups).toEqual([]);
    f.tabs[0]!.url = "https://other.my.salesforce.com";
    delete f.tabs[0]!.pendingUrl;
    c.mark(1);
    await c.flush();
    expect(f.groups[0]?.title).toContain("other");
  });
  it("keeps Lightning ↔ Setup in one group, moves A → C, and ungroups on exit", async () => {
    const { f, c } = await setup();
    const first = f.tabs[0]!.groupId,
      writes = f.writes.length;
    f.tabs[0]!.url = "https://acme.my.salesforce-setup.com";
    c.mark(1);
    await c.flush();
    expect(f.tabs[0]!.groupId).toBe(first);
    expect(f.writes).toHaveLength(writes);
    f.tabs[0]!.url = "https://b.my.salesforce.com";
    c.mark(1);
    f.tabs[0]!.url = "https://c.my.salesforce.com";
    c.mark(1);
    await c.flush();
    expect(f.groups[0]?.title).toBe("c");
    f.tabs[0]!.url = "https://example.com";
    c.mark(1);
    await c.flush();
    expect(f.tabs[0]!.groupId).toBe(-1);
    expect(f.groups).toEqual([]);
  });
  it("manual ungroup persists across worker restart and navigation until restored", async () => {
    const { f, c, repo, local, session } = await setup();
    f.userUngroup(1);
    c.mark(1);
    await c.flush();
    expect(repo.runtime.overrides[1]).toBeDefined();
    const restartedRepo = new Repository(local, session);
    const restarted = new Coordinator(f, restartedRepo);
    f.onEcho = (w) => restarted.mark(w);
    await restarted.bootstrapPromise;
    f.tabs[0]!.url = "https://other.my.salesforce.com";
    restarted.mark(1);
    await restarted.flush();
    expect(f.tabs[0]!.groupId).toBe(-1);
    await restarted.restoreTab(1);
    await restarted.flush();
    expect(f.tabs[0]!.groupId).not.toBe(-1);
  });
  it("keeps managing renamed groups without visible markers", async () => {
    const { f, c, repo } = await setup(2);
    const original = f.groups[0]!;
    original.title = "My custom group";
    c.mark(1);
    await c.flush();
    expect(repo.ownership[0]?.status).toBe("active");
    f.tabs.push(tab(3, "https://acme.my.salesforce.com"));
    c.mark(1);
    await c.flush();
    expect(f.groups).toHaveLength(1);
    expect(f.tabs[2]?.groupId).toBe(original.id);
    expect(f.groups.find((g) => g.id === original.id)?.title).toBe(
      "My custom group",
    );
    expect(repo.ownership.filter((r) => r.status === "active")).toHaveLength(1);
  });
  it("preserves user colors and title, releases foreign inserted members", async () => {
    const { f, c, repo } = await setup(2);
    f.groups[0]!.title = "Custom " + f.groups[0]!.title;
    f.groups[0]!.color = "pink";
    c.mark(1);
    await c.flush();
    expect(f.groups[0]?.color).toBe("pink");
    expect(f.groups[0]?.title).toMatch(/^Custom/);
    f.tabs.push(
      tab(3, "https://other.my.salesforce.com", 1, {
        groupId: f.groups[0]!.id,
      }),
    );
    c.mark(1);
    await c.flush();
    expect(repo.ownership[0]?.status).toBe("released");
    expect(new Set(f.tabs.map((t) => t.groupId)).size).toBe(1);
  });
  it("expands a collapsed target before joining an active tab without changing focus", async () => {
    const { f, c } = await setup(2);
    f.tabs[0]!.active = false;
    f.groups[0]!.collapsed = true;
    f.tabs.push(tab(3, "https://acme.my.salesforce.com", 1, { active: true }));
    const offset = f.writes.length;
    c.mark(1);
    await c.flush();
    expect(f.writes.slice(offset).map((w) => w.kind)).toEqual([
      "metadata",
      "join",
    ]);
    expect(f.tabs.find((t) => t.id === 3)?.active).toBe(true);
    expect(f.windows[0]?.focused).toBe(true);
  });
  it("switch off preserves groups and prevents pending side effects", async () => {
    const { f, c, repo } = await setup();
    const oldId = f.tabs[0]!.groupId;
    await repo.saveSettings({
      ...repo.settings,
      autoGroupingEnabled: false,
      revision: 1,
    });
    f.tabs.push(tab(2, "https://other.my.salesforce.com"));
    await c.settingsChanged();
    await c.flush();
    expect(f.tabs.find((t) => t.id === 2)?.groupId).toBe(-1);
    expect(f.tabs[0]!.groupId).toBe(oldId);
    await repo.saveSettings({
      ...repo.settings,
      autoGroupingEnabled: true,
      revision: 2,
    });
    await c.settingsChanged();
    await c.flush();
    expect(f.tabs.find((t) => t.id === 2)?.groupId).not.toBe(-1);
  });
  it("migrates legacy markers after cold restore with renumbered IDs", async () => {
    const { f, local, repo: oldRepo } = await setup(2);
    f.groups[0]!.title += ` [SFN:${oldRepo.ownership[0]!.token}]`;
    f.groups[0]!.id = 900;
    f.groups[0]!.windowId = 2;
    f.windows[0]!.id = 2;
    for (const t of f.tabs) {
      t.groupId = 900;
      t.windowId = 2;
      t.id = t.id! + 100;
    }
    const repo = new Repository(local, new MemoryStorage()),
      c = new Coordinator(f, repo);
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    await c.flush();
    expect(repo.runtime.bindings[0]?.groupId).toBe(900);
    expect(f.groups[0]?.title).toBe("acme");
    expect(f.writes.filter((w) => w.kind === "create")).toHaveLength(1);
  });
  it("does not turn legacy cold mixed/unknown restore into cleanup mutations", async () => {
    const { f, local, repo: oldRepo } = await setup(2);
    f.groups[0]!.title += ` [SFN:${oldRepo.ownership[0]!.token}]`;
    f.tabs[1]!.url = undefined;
    const repo = new Repository(local, new MemoryStorage());
    const c = new Coordinator(f, repo);
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    await c.flush();
    expect(repo.runtime.bindings[0]?.status).toBe("recovering");
    const writes = f.writes.length;
    f.tabs[1]!.url = "https://other.my.salesforce.com";
    c.mark(1);
    await c.flush();
    expect(f.writes).toHaveLength(writes);
    expect(repo.ownership[0]?.status).toBe("released");
  });
  it("recovers plain titles after worker restart from session bindings", async () => {
    const { f, local, session } = await setup(2);
    expect(f.groups[0]?.title).toBe("acme");
    const repo = new Repository(local, session);
    const c = new Coordinator(f, repo);
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    f.tabs.push(tab(3, "https://acme.my.salesforce.com"));
    await c.flush();
    expect(f.groups).toHaveLength(1);
    expect(f.tabs[2]?.groupId).toBe(f.groups[0]?.id);
    expect(repo.runtime.bindings).toHaveLength(1);
  });
  it("protects plain restored groups when the browser session binding is gone", async () => {
    const { f, local } = await setup(2);
    const before = structuredClone(f.groups);
    const writes = f.writes.length;
    const repo = new Repository(local, new MemoryStorage());
    const c = new Coordinator(f, repo);
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    await c.flush();
    expect(repo.runtime.bindings).toEqual([]);
    expect(f.groups).toEqual(before);
    expect(f.writes).toHaveLength(writes);
  });
  it("names sandbox groups after the tenant and honors aliases without a marker", async () => {
    const { f, c, repo } = await setup();
    f.tabs.push(
      tab(2, "https://casecentral--uatpes.sandbox.lightning.force.com"),
    );
    c.mark(1);
    await c.flush();
    expect(f.groups.map((g) => g.title)).toEqual(["acme", "uatpes"]);
    await repo.saveSettings({
      ...repo.settings,
      revision: 1,
      tenantPreferences: {
        "sf:commercial:sandbox:casecentral--dev": { alias: "开发" },
      },
    });
    f.tabs.push(tab(3, "https://casecentral--dev.sandbox.my.salesforce.com"));
    await c.settingsChanged();
    await c.flush();
    expect(f.groups.map((g) => g.title)).toEqual(["acme", "uatpes", "开发"]);
  });
  it("storage corruption fails closed and preserves raw data", async () => {
    const f = new FakeChrome();
    f.tabs = [tab(1, "https://acme.my.salesforce.com")];
    const local = new MemoryStorage(),
      session = new MemoryStorage();
    local.data.settings = { schemaVersion: 99 };
    const c = new Coordinator(f, new Repository(local, session));
    await expect(c.bootstrapPromise).rejects.toThrow();
    expect(c.degraded).toBeTruthy();
    expect(f.writes).toEqual([]);
    expect(local.data.settings).toEqual({ schemaVersion: 99 });
    expect(local.writes).toBe(0);
  });
  it("replacement is conservatively excluded; tab close removes overrides", async () => {
    const { f, c, repo } = await setup();
    f.userUngroup(1);
    f.tabs[0]!.id = 2;
    await c.replaced(2, 1);
    await c.flush();
    expect(repo.runtime.overrides[2]?.reason).toBe("uncertain-replacement");
    f.tabs = [];
    await c.removed(2, 1);
    await c.flush();
    expect(repo.runtime.overrides).toEqual({});
  });
  it("protects detached tabs until attached and reconciles their destination window", async () => {
    const { f, c, repo } = await setup(0);
    f.addWindow(2);
    f.tabs.push(tab(1, "https://acme.my.salesforce.com"));
    c.detached(1, 1);
    await c.flush();
    expect(f.writes).toEqual([]);
    expect(repo.runtime.reasons.detached).toBe(1);
    f.tabs[0]!.windowId = 2;
    c.attached(1, 2);
    await c.flush();
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]?.windowId).toBe(2);
    expect(f.tabs[0]?.groupId).toBe(f.groups[0]?.id);
  });
  it("drag errors persist bounded retries instead of repeated writes", async () => {
    const { f, c, repo } = await setup(0);
    f.tabs.push(tab(1, "https://acme.my.salesforce.com"));
    f.boundary = (name) => {
      if (name === "create.before")
        throw new Error(
          "Tabs cannot be edited right now (user may be dragging a tab)",
        );
    };
    c.mark(1);
    await c.flush();
    expect(repo.runtime.retries[1]?.attempts).toBe(1);
    expect(f.groups).toHaveLength(0);
    expect(runtimeSchema.safeParse(repo.runtime).success).toBe(true);
  });
});

describe("worker termination at each creation storage/API boundary", () => {
  async function attempt(stopAt: number) {
    let step = -1_000_000;
    const boundary = () => {
      if (++step === stopAt) throw new Error("worker-terminated");
    };
    const f = new FakeChrome();
    f.tabs = [
      tab(1, "https://acme.my.salesforce.com"),
      tab(2, "https://acme.lightning.force.com"),
    ];
    const local = new MemoryStorage(boundary, "local"),
      session = new MemoryStorage(boundary, "session");
    const repo = new Repository(local, session);
    await repo.load();
    const snapshot = await f.snapshot();
    const executor = new Executor(f, repo, () => true);
    step = 0;
    f.boundary = boundary;
    try {
      await executor.execute(
        {
          kind: "create",
          windowId: 1,
          tenantKey: "sf:commercial:unpartitioned:acme",
          tabIds: [1, 2],
        },
        snapshot,
        0,
      );
    } catch (error) {
      expect(String(error)).toMatch(/worker-terminated|存储/);
    }
    const total = step;
    f.boundary = () => {};
    step = -1_000_000;
    const restarted = new Coordinator(f, new Repository(local, session));
    f.onEcho = (w) => restarted.mark(w);
    await restarted.bootstrapPromise;
    await restarted.flush();
    expect(f.groups.length).toBeLessThanOrEqual(1);
    expect(f.tabs.every((t) => t.groupId !== -1)).toBe(true);
    expect(f.writes.filter((w) => w.kind === "create")).toHaveLength(1);
    return total;
  }
  it("restores facts without duplicate groups at every await boundary", async () => {
    // First measure the actual path so newly added awaited boundaries are tested.
    const steps = await attempt(Number.MAX_SAFE_INTEGER);
    for (let stop = 1; stop <= steps; stop++) await attempt(stop);
    expect(steps).toBeGreaterThan(20);
  });
});
