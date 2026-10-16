import { describe, it, expect } from "vitest";
import {
  newToken,
  resolveOwnership,
} from "../src/background/ownershipRegistry";
import {
  defaultRuntime,
  type Registration,
  type Binding,
} from "../src/shared/models/runtime";
import { observe } from "../src/features/tab-grouper/observation";
import { FakeChrome, tab, group } from "./fakeChrome";
const key = "sf:commercial:unpartitioned:acme",
  token = "abcdefghijklmnop";
const registration: Registration = {
  tenantKey: key,
  token,
  status: "active",
  createdAt: 0,
};
const binding: Binding = {
  groupId: 10,
  windowId: 1,
  tenantKey: key,
  token,
  status: "verified",
  since: 0,
};
async function fixture() {
  const f = new FakeChrome();
  f.tabs = [tab(1, "https://acme.my.salesforce.com", 1, { groupId: 10 })];
  f.groups = [group(10, 1, `acme [SFN:${token}]`)];
  return f;
}
describe("ownership and manual intent", () => {
  it("generates 96-bit unique base64url tokens", () => {
    const tokens = Array.from({ length: 100 }, newToken);
    expect(new Set(tokens).size).toBe(100);
    expect(tokens.every((t) => /^[\w-]{16}$/.test(t))).toBe(true);
  });
  it("does not claim names, unknown tokens or tombstones", async () => {
    const f = await fixture();
    const r = defaultRuntime();
    expect(resolveOwnership(await f.snapshot(), r, []).bindings).toEqual([]);
    expect(
      resolveOwnership(await f.snapshot(), r, [
        { ...registration, status: "released" },
      ]).bindings,
    ).toEqual([]);
    f.groups[0]!.title = "acme";
    expect(
      resolveOwnership(await f.snapshot(), r, [registration]).bindings,
    ).toEqual([]);
  });
  it("recovers exact tokens with validated members and allows one per window", async () => {
    const f = await fixture();
    f.addWindow(2);
    f.groups.push(group(20, 2, `acme [SFN:${token}]`));
    f.tabs.push(tab(2, "https://acme.lightning.force.com", 2, { groupId: 20 }));
    expect(
      resolveOwnership(await f.snapshot(), defaultRuntime(), [registration])
        .bindings,
    ).toHaveLength(2);
  });
  it("protects copied legacy markers and preserves bindings after marker removal", async () => {
    const f = await fixture();
    f.groups.push(group(20, 1, `copy [SFN:${token}]`));
    f.tabs.push(tab(2, "https://acme.my.salesforce.com", 1, { groupId: 20 }));
    expect(
      resolveOwnership(await f.snapshot(), defaultRuntime(), [
        registration,
      ]).released.has(token),
    ).toBe(true);
    f.groups.pop();
    f.groups[0]!.title = "renamed";
    const r = defaultRuntime();
    r.bindings = [binding];
    expect(
      resolveOwnership(await f.snapshot(), r, [registration]).released.has(
        token,
      ),
    ).toBe(false);
  });
  it("cold unknown members defer while mixed members release", async () => {
    const f = await fixture();
    f.tabs[0]!.url = undefined;
    expect(
      resolveOwnership(
        await f.snapshot(),
        defaultRuntime(),
        [registration],
        1000,
      ).bindings[0]?.status,
    ).toBe("recovering");
    f.tabs[0]!.url = "https://other.my.salesforce.com";
    expect(
      resolveOwnership(await f.snapshot(), defaultRuntime(), [
        registration,
      ]).released.has(token),
    ).toBe(true);
  });
  it("distinguishes own navigation from inserted foreign membership", async () => {
    const f = await fixture();
    const r = defaultRuntime();
    r.bindings = [binding];
    r.observations[1] = observe(f.tabs[0]!);
    f.tabs[0]!.url = "https://other.my.salesforce.com";
    expect(
      resolveOwnership(await f.snapshot(), r, [registration]).bindings[0]
        ?.status,
    ).toBe("verified");
    f.tabs.push(tab(2, "https://other.my.salesforce.com", 1, { groupId: 10 }));
    expect(
      resolveOwnership(await f.snapshot(), r, [registration]).released.has(
        token,
      ),
    ).toBe(true);
  });
  it("records manual ungroup and respects pin without an override", async () => {
    const f = await fixture(),
      r = defaultRuntime();
    r.bindings = [binding];
    r.observations[1] = observe(f.tabs[0]!);
    f.userUngroup(1);
    resolveOwnership(await f.snapshot(), r, [registration]);
    expect(r.overrides[1]?.reason).toBe("manual-ungroup");
    delete r.overrides[1];
    f.tabs[0]!.pinned = true;
    resolveOwnership(await f.snapshot(), r, [registration]);
    expect(r.overrides[1]).toBeUndefined();
  });
});
