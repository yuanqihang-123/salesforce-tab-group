import { describe, it, expect } from "vitest";
import { plan } from "../src/features/tab-grouper/planner";
import { defaultRuntime, type Binding } from "../src/shared/models/runtime";
import { defaultSettings } from "../src/shared/models/settings";
import { type Snapshot } from "../src/shared/chrome/types";
import { observe } from "../src/features/tab-grouper/observation";
import { FakeChrome, tab, group } from "./fakeChrome";
const key = "sf:commercial:unpartitioned:acme";
const binding: Binding = {
  windowId: 1,
  groupId: 10,
  tenantKey: key,
  token: "abcdefghijklmnop",
  status: "verified",
  since: 0,
};
function s(tabs: Snapshot["tabs"], groups: Snapshot["groups"] = []) {
  return { tabs, groups, windows: new FakeChrome().windows };
}
describe("minimal-diff planner", () => {
  it("batches same-window tenant and separates windows", () => {
    const snapshot = s([
      tab(1, "https://acme.my.salesforce.com"),
      tab(2, "https://acme.lightning.force.com"),
      tab(3, "https://acme.my.site.com", 2),
    ]);
    snapshot.windows.push({ ...snapshot.windows[0]!, id: 2 });
    const p = plan(snapshot, defaultSettings(), defaultRuntime(), []);
    expect(p.actions).toHaveLength(2);
    expect(p.actions[0]?.tabIds).toEqual([1, 2]);
  });
  it("protects groups, pinned, overrides and split view", () => {
    const r = defaultRuntime();
    r.overrides[3] = { tabId: 3, reason: "manual-ungroup", createdAt: 0 };
    const p = plan(
      s(
        [
          tab(1, "https://acme.my.salesforce.com", 1, { groupId: 20 }),
          tab(2, "https://acme.my.salesforce.com", 1, { pinned: true }),
          tab(3, "https://acme.my.salesforce.com"),
          tab(4, "https://acme.my.salesforce.com", 1, { splitViewId: 0 }),
        ],
        [group(20)],
      ),
      defaultSettings(),
      r,
      [],
    );
    expect(p.actions).toEqual([]);
    expect(p.reasons).toMatchObject({
      "protected-group": 1,
      pinned: 1,
      "manual-override": 1,
      "split-view": 1,
    });
  });
  it("performs zero writes for correct membership and expands only active group", () => {
    const snapshot = s(
      [tab(1, "https://acme.my.salesforce.com", 1, { groupId: 10 })],
      [group(10)],
    );
    expect(
      plan(snapshot, defaultSettings(), defaultRuntime(), [binding]).actions,
    ).toEqual([]);
    snapshot.groups[0]!.collapsed = true;
    expect(
      plan(snapshot, defaultSettings(), defaultRuntime(), [binding]).actions[0]
        ?.kind,
    ).toBe("expand");
  });
  it("joins an existing binding, defers a recovering binding", () => {
    const snapshot = s([tab(1, "https://acme.my.salesforce.com")], [group(10)]);
    expect(
      plan(snapshot, defaultSettings(), defaultRuntime(), [binding]).actions[0]
        ?.kind,
    ).toBe("join");
    expect(
      plan(snapshot, defaultSettings(), defaultRuntime(), [
        { ...binding, status: "recovering" },
      ]).actions,
    ).toEqual([]);
  });
  it("waits for final committed URL, including pending-only create", () => {
    for (const t of [
      tab(1, undefined, 1, { pendingUrl: "https://acme.my.salesforce.com" }),
      tab(1, "https://acme.my.salesforce.com", 1, {
        pendingUrl: "https://other.my.salesforce.com",
      }),
    ])
      expect(
        plan(s([t]), defaultSettings(), defaultRuntime(), []).actions,
      ).toEqual([]);
  });
  it("only removes owned outgoing web tabs; blank/login have grace, errors stay", () => {
    for (const url of [
      "https://example.com",
      "http://acme.my.salesforce.com",
      "about:blank",
      "https://login.salesforce.com/",
      "chrome-error://chromewebdata/",
    ]) {
      const t = tab(1, url, 1, { groupId: 10 });
      const r = defaultRuntime();
      r.observations[1] = observe(t, undefined, 1000);
      const snapshot = s([t], [group(10)]);
      const initial = plan(
        snapshot,
        defaultSettings(),
        r,
        [binding],
        2000,
      ).actions;
      expect(initial.some((a) => a.kind === "ungroup")).toBe(
        !url.startsWith("about:") &&
          !url.includes("login.salesforce") &&
          !url.startsWith("chrome-error:"),
      );
      expect(
        plan(snapshot, defaultSettings(), r, [binding], 12000).actions.some(
          (a) => a.kind === "ungroup",
        ),
      ).toBe(!url.startsWith("chrome-error:"));
    }
  });
  it("disabling or tenant exclusion never dismantles a group", () => {
    const settings = defaultSettings();
    settings.autoGroupingEnabled = false;
    expect(
      plan(
        s([tab(1, "https://example.com", 1, { groupId: 10 })], [group(10)]),
        settings,
        defaultRuntime(),
        [binding],
      ).actions,
    ).toEqual([]);
    settings.autoGroupingEnabled = true;
    settings.excludedTenants = [key];
    expect(
      plan(
        s([tab(1, "https://example.com", 1, { groupId: 10 })], [group(10)]),
        settings,
        defaultRuntime(),
        [binding],
      ).actions,
    ).toEqual([]);
  });
});
