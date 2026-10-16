import { describe, it, expect } from "vitest";
import { Coordinator } from "../src/background/coordinator";
import { Executor, StalePlan } from "../src/background/executor";
import { Repository, StorageFailure } from "../src/shared/storage/repository";
import { defaultRuntime } from "../src/shared/models/runtime";
import { observe } from "../src/features/tab-grouper/observation";
import { resolveOwnership } from "../src/background/ownershipRegistry";
import { FakeChrome, MemoryStorage, tab, group } from "./fakeChrome";
async function boot() {
  const f = new FakeChrome();
  f.tabs = [
    tab(1, "https://acme.my.salesforce.com"),
    tab(2, "https://acme.lightning.force.com"),
  ];
  const local = new MemoryStorage(),
    session = new MemoryStorage(),
    repo = new Repository(local, session),
    c = new Coordinator(f, repo);
  f.onEcho = (w) => c.mark(w);
  await c.bootstrapPromise;
  await c.flush();
  return { f, repo, c, local, session };
}
describe("adversarial operations and stored facts", () => {
  it("checks fresh settings after a durable creation journal", async () => {
    const f = new FakeChrome();
    f.tabs = [tab(1, "https://acme.my.salesforce.com")];
    const local = new MemoryStorage(),
      session = new MemoryStorage(),
      repo = new Repository(local, session);
    await repo.load();
    const snapshot = await f.snapshot();
    const executor = new Executor(f, repo, () => true);
    const original = session.set.bind(session);
    session.set = async (items) => {
      await original(items);
      const runtime = items.runtime as typeof repo.runtime;
      if (runtime.intents.length)
        local.data.settings = {
          ...repo.settings,
          autoGroupingEnabled: false,
          revision: 1,
        };
    };
    await expect(
      executor.execute(
        {
          kind: "create",
          windowId: 1,
          tabIds: [1],
          tenantKey: "sf:commercial:unpartitioned:acme",
        },
        snapshot,
        0,
      ),
    ).rejects.toBeInstanceOf(StalePlan);
    expect(f.writes).toEqual([]);
  });
  it("rejects a navigation or group change while preparing an action", async () => {
    for (const mutate of [
      (f: FakeChrome) => {
        f.tabs[0]!.url = "https://other.my.salesforce.com";
      },
      (f: FakeChrome) => {
        f.tabs[0]!.splitViewId = 7;
      },
      (f: FakeChrome) => {
        f.tabs[0]!.incognito = true;
      },
      (f: FakeChrome) => {
        f.tabs[0]!.active = false;
      },
      (f: FakeChrome) => {
        f.tabs[0]!.groupId = 22;
        f.groups.push(group(22));
      },
    ]) {
      const f = new FakeChrome();
      f.tabs = [tab(1, "https://acme.my.salesforce.com")];
      const local = new MemoryStorage(),
        session = new MemoryStorage(),
        repo = new Repository(local, session);
      await repo.load();
      const snapshot = await f.snapshot();
      const original = session.set.bind(session);
      session.set = async (items) => {
        await original(items);
        if ((items.runtime as typeof repo.runtime).intents.length) mutate(f);
      };
      await expect(
        new Executor(f, repo, () => true).execute(
          {
            kind: "create",
            windowId: 1,
            tabIds: [1],
            tenantKey: "sf:commercial:unpartitioned:acme",
          },
          snapshot,
          0,
        ),
      ).rejects.toBeInstanceOf(StalePlan);
      expect(f.writes).toEqual([]);
    }
  });
  it("manual regroup into another tenant releases the target rather than pulling back", async () => {
    const { f, c, repo } = await boot();
    f.tabs.push(tab(3, "https://other.my.salesforce.com"));
    c.mark(1);
    await c.flush();
    const target = f.tabs.find((t) => t.id === 3)!.groupId;
    f.userJoin(1, target);
    c.mark(1);
    await c.flush();
    expect(f.tabs.find((t) => t.id === 1)?.groupId).toBe(target);
    expect(repo.runtime.overrides[1]).toBeDefined();
    expect(
      repo.ownership.find(
        (r) => r.tenantKey === "sf:commercial:unpartitioned:other",
      )?.status,
    ).toBe("released");
    const writes = f.writes.length;
    c.mark(1);
    await c.flush();
    expect(f.writes).toHaveLength(writes);
  });
  it("pin/unpin reevaluates without a manual override", async () => {
    const { f, c, repo } = await boot();
    f.userUngroup(1);
    f.tabs.find((t) => t.id === 1)!.pinned = true;
    c.mark(1);
    await c.flush();
    expect(repo.runtime.overrides[1]).toBeUndefined();
    f.tabs.find((t) => t.id === 1)!.pinned = false;
    c.mark(1);
    await c.flush();
    expect(f.tabs.find((t) => t.id === 1)?.groupId).not.toBe(-1);
  });
  it("whole-group moves rebind in the destination and never move tabs back", async () => {
    const { f, c, repo } = await boot();
    f.addWindow(2);
    f.groups[0]!.windowId = 2;
    for (const t of f.tabs) t.windowId = 2;
    c.mark(1);
    c.mark(2);
    await c.flush();
    expect(repo.runtime.bindings[0]?.windowId).toBe(2);
    expect(repo.runtime.overrides).toEqual({});
    expect(f.tabs.every((t) => t.windowId === 2)).toBe(true);
  });
  it("moved whole groups can merge when both ownerships are proven", async () => {
    const { f, c, repo } = await boot();
    f.addWindow(2);
    f.tabs.push(tab(3, "https://acme.my.salesforce.com", 2));
    c.mark(2);
    await c.flush();
    const moved = f.groups.find((g) => g.windowId === 1)!;
    moved.windowId = 2;
    for (const t of f.tabs) if (t.groupId === moved.id) t.windowId = 2;
    c.mark(1);
    c.mark(2);
    await c.flush();
    expect(f.groups).toHaveLength(1);
    expect(repo.runtime.overrides).toEqual({});
    expect(f.tabs.every((t) => t.windowId === 2)).toBe(true);
  });
  it("session storage write failure stops browser mutations", async () => {
    const f = new FakeChrome();
    f.tabs = [tab(1, "https://acme.my.salesforce.com")];
    const local = new MemoryStorage(),
      session = new MemoryStorage();
    session.set = async () => {
      throw new Error("disk failure");
    };
    const c = new Coordinator(f, new Repository(local, session));
    await expect(c.bootstrapPromise).rejects.toBeInstanceOf(StorageFailure);
    expect(c.degraded).toBeTruthy();
    expect(f.writes).toEqual([]);
  });
  it("unknown runtime schema never overwrites the original data", async () => {
    const local = new MemoryStorage(),
      session = new MemoryStorage();
    session.data.runtime = { schemaVersion: 99, raw: "preserve" };
    const repo = new Repository(local, session);
    await expect(repo.load()).rejects.toBeInstanceOf(StorageFailure);
    expect(session.data.runtime).toEqual({
      schemaVersion: 99,
      raw: "preserve",
    });
    expect(local.writes).toBe(0);
  });
  it("cold restore stays recovering after 60 seconds of unavailable URL", async () => {
    const r = defaultRuntime();
    const token = "abcdefghijklmnop";
    const f = new FakeChrome();
    f.tabs = [tab(1, undefined, 1, { groupId: 10 })];
    f.groups = [group(10, 1, `acme [SFN:${token}]`)];
    const reg = {
      token,
      tenantKey: "sf:commercial:unpartitioned:acme" as const,
      status: "active" as const,
      createdAt: 0,
    };
    r.bindings = resolveOwnership(await f.snapshot(), r, [reg], 1000).bindings;
    const result = resolveOwnership(await f.snapshot(), r, [reg], 62000);
    expect(result.reasons["recovery-timeout"]).toBe(1);
    expect(result.bindings[0]?.status).toBe("recovering");
  });
  it("transient grace restarts when navigation settles", () => {
    const t = tab(1, "about:blank", 1, { status: "loading" }),
      a = observe(t, undefined, 1000);
    t.status = "complete";
    const b = observe(t, a, 20000);
    expect(b.stableSince).toBe(20000);
  });
  it("500-tab, 5-window snapshot converges with one create per window/tenant", async () => {
    const f = new FakeChrome();
    for (let w = 2; w <= 5; w++) f.addWindow(w);
    f.tabs = Array.from({ length: 500 }, (_, i) =>
      tab(
        i + 1,
        `https://org${i % 4}.my.salesforce.com`,
        1 + Math.floor(i / 100),
      ),
    );
    const c = new Coordinator(
      f,
      new Repository(new MemoryStorage(), new MemoryStorage()),
    );
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    await c.flush();
    expect(f.groups).toHaveLength(20);
    expect(f.writes.filter((w) => w.kind === "create")).toHaveLength(20);
    const writes = f.writes.length;
    await c.scan();
    await c.flush();
    expect(f.writes).toHaveLength(writes);
  });
});

describe("last-await ownership checks", () => {
  it.each(["rename", "foreign-member", "shared", "marker-copy"])(
    "does not stamp a creation journal after %s during storage await",
    async (mutation) => {
      const f = new FakeChrome();
      f.tabs = [tab(1, "https://acme.my.salesforce.com")];
      const local = new MemoryStorage(),
        session = new MemoryStorage(),
        repo = new Repository(local, session);
      await repo.load();
      const snapshot = await f.snapshot(),
        original = session.set.bind(session);
      let mutated = false;
      session.set = async (items) => {
        await original(items);
        const r = items.runtime as typeof repo.runtime;
        if (
          !mutated &&
          r.intents.some((i) => i.kind === "create" && i.phase === "applied")
        ) {
          mutated = true;
          const g = f.groups[0]!;
          if (mutation === "rename") g.title = "My own group";
          if (mutation === "foreign-member")
            f.tabs.push(
              tab(2, "https://other.my.salesforce.com", 1, { groupId: g.id }),
            );
          if (mutation === "shared") g.shared = true;
          if (mutation === "marker-copy")
            g.title = "Another [SFN:abcdefghijklmnop]";
        }
      };
      await new Executor(f, repo, () => true).execute(
        {
          kind: "create",
          windowId: 1,
          tabIds: [1],
          tenantKey: "sf:commercial:unpartitioned:acme",
        },
        snapshot,
        0,
      );
      expect(f.writes.filter((w) => w.kind === "metadata")).toEqual([]);
      expect(repo.runtime.bindings).toEqual([]);
    },
  );
  it("does not move a source member when its group is renamed during journal preparation", async () => {
    const { f, repo } = await boot();
    const source = f.tabs.find((t) => t.id === 1)!;
    source.url = "https://other.my.salesforce.com";
    const snapshot = await f.snapshot();
    const original = repo.saveRuntime.bind(repo);
    let removed = false;
    repo.saveRuntime = async () => {
      await original();
      if (!removed && repo.runtime.intents.some((i) => i.kind === "create")) {
        removed = true;
        f.groups.find((g) => g.id === source.groupId)!.title = "Protected now";
      }
    };
    const writes = f.writes.length;
    await expect(
      new Executor(f, repo, () => true).execute(
        {
          kind: "create",
          windowId: 1,
          tabIds: [1],
          tenantKey: "sf:commercial:unpartitioned:other",
        },
        snapshot,
        0,
      ),
    ).rejects.toBeInstanceOf(StalePlan);
    expect(f.writes).toHaveLength(writes);
    expect(repo.runtime.intents.filter((i) => i.phase === "prepared")).toEqual(
      [],
    );
  });
});

describe("expired journal protection", () => {
  it("never claims an unmarked group from an expired creation intent", async () => {
    const f = new FakeChrome();
    f.tabs = [tab(1, "https://acme.my.salesforce.com")];
    const local = new MemoryStorage(),
      session = new MemoryStorage(),
      repo = new Repository(local, session);
    await repo.load();
    const snapshot = await f.snapshot();
    f.boundary = (name) => {
      if (name === "create.after") throw new Error("worker-terminated");
    };
    await expect(
      new Executor(f, repo, () => true).execute(
        {
          kind: "create",
          windowId: 1,
          tabIds: [1],
          tenantKey: "sf:commercial:unpartitioned:acme",
        },
        snapshot,
        0,
      ),
    ).rejects.toThrow("worker-terminated");
    f.boundary = () => {};
    repo.runtime.intents[0]!.expiresAt = Date.now() - 1;
    await repo.saveRuntime();
    const restartedRepo = new Repository(local, session);
    const restarted = new Coordinator(f, restartedRepo);
    await restarted.bootstrapPromise;
    await restarted.flush();
    expect(f.writes.filter((w) => w.kind === "metadata")).toEqual([]);
    expect(restartedRepo.runtime.bindings).toEqual([]);
    expect(restartedRepo.runtime.degraded).toBe("ambiguous-journal");
  });
});
