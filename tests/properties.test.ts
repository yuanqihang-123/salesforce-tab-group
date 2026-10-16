import { it, expect } from "vitest";
import { Coordinator } from "../src/background/coordinator";
import { Repository } from "../src/shared/storage/repository";
import { FakeChrome, MemoryStorage, tab, group } from "./fakeChrome";
it("generated event traces preserve protected groups, pinned tabs, active state and window locations", async () => {
  for (let seed = 1; seed <= 12; seed++) {
    let random = seed;
    const next = (n: number) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random % n;
    };
    const f = new FakeChrome();
    f.addWindow(2);
    f.groups = [
      group(900, 1, "User workspace", { color: "pink", collapsed: true }),
    ];
    f.tabs = [
      tab(1, "https://acme.my.salesforce.com", 1, { groupId: 900 }),
      tab(2, "https://other.my.salesforce.com", 2),
      tab(3, "https://acme.lightning.force.com"),
    ];
    const repo = new Repository(new MemoryStorage(), new MemoryStorage());
    const c = new Coordinator(f, repo);
    f.onEcho = (w) => c.mark(w);
    await c.bootstrapPromise;
    await c.flush();
    let id = 3;
    for (let step = 0; step < 35; step++) {
      const candidate = f.tabs[1 + next(Math.max(1, f.tabs.length - 1))];
      switch (next(7)) {
        case 0:
          f.tabs.push(
            tab(++id, `https://org${next(3)}.my.salesforce.com`, 1 + next(2)),
          );
          break;
        case 1:
          if (candidate)
            candidate.url =
              next(3) === 0
                ? "https://example.com"
                : `https://org${next(3)}.lightning.force.com`;
          break;
        case 2:
          if (candidate) {
            candidate.pinned = true;
            f.userUngroup(candidate.id!);
          }
          break;
        case 3:
          if (candidate) candidate.pinned = false;
          break;
        case 4:
          if (candidate && !candidate.pinned && candidate.windowId === 1)
            f.userJoin(candidate.id!, 900);
          break;
        case 5:
          if (candidate && !candidate.pinned) f.userUngroup(candidate.id!);
          break;
        case 6:
          if (candidate && candidate.id !== 1) {
            f.tabs = f.tabs.filter((t) => t.id !== candidate.id);
            f.groups = f.groups.filter((g) =>
              f.tabs.some((t) => t.groupId === g.id),
            );
            await c.removed(candidate.id!, candidate.windowId);
          }
          break;
      }
      const locations = new Map(f.tabs.map((t) => [t.id, t.windowId])),
        active = new Map(f.tabs.map((t) => [t.id, t.active]));
      const pinned = f.tabs.filter((t) => t.pinned).map((t) => t.id);
      const protectedGroups = f.groups
        .filter((g) => !repo.runtime.bindings.some((b) => b.groupId === g.id))
        .map((g) => ({
          group: structuredClone(g),
          ids: f.tabs
            .filter((t) => t.groupId === g.id)
            .map((t) => t.id)
            .sort(),
        }));
      c.mark(1);
      c.mark(2);
      await c.flush();
      for (const before of protectedGroups) {
        expect(f.groups.find((g) => g.id === before.group.id)).toEqual(
          before.group,
        );
        expect(
          f.tabs
            .filter((t) => t.groupId === before.group.id)
            .map((t) => t.id)
            .sort(),
        ).toEqual(before.ids);
      }
      for (const t of f.tabs) {
        expect(t.windowId).toBe(locations.get(t.id));
        expect(t.active).toBe(active.get(t.id));
        if (pinned.includes(t.id)) expect(t.pinned).toBe(true);
      }
      const unique = new Set<string>();
      for (const b of repo.runtime.bindings.filter(
        (b) => b.status === "verified",
      )) {
        const key = `${b.windowId}/${b.tenantKey}`;
        expect(unique.has(key)).toBe(false);
        unique.add(key);
      }
    }
  }
});
