import { describe, it, expect } from "vitest";
import { transformUrl } from "../src/features/org-switcher/urlTransformer";
import { Switcher } from "../src/features/org-switcher/switcher";
import {
  defaultSettings,
  switchTargetSchema,
  type SwitchTarget,
} from "../src/shared/models/settings";
import { Repository } from "../src/shared/storage/repository";
import { MemoryStorage, tab } from "./fakeChrome";
const target: SwitchTarget = {
  id: "uat",
  label: "UAT",
  tenantKey: "sf:commercial:sandbox:acme--uat",
  origins: {
    lightning: "https://acme--uat.sandbox.lightning.force.com",
    "my-domain": "https://acme--uat.sandbox.my.salesforce.com",
    setup: "https://acme--uat.sandbox.my.salesforce-setup.com",
  },
};
describe("explicit Org Switcher", () => {
  it("maps exact surfaces and strips all unallowlisted query and hash", () => {
    for (const [surface, host] of [
      ["lightning", "acme.lightning.force.com"],
      ["my-domain", "acme.my.salesforce.com"],
      ["setup", "acme.my.salesforce-setup.com"],
    ] as const) {
      const p = transformUrl(
        `https://${host}/lightning/page/home?sid=secret&access_token=x&code=y&retURL=https://evil.example#token`,
        target,
      );
      expect(p.url).toBe(target.origins[surface] + "/lightning/page/home");
    }
  });
  it("only retains a tested list-view parameter", () => {
    expect(
      transformUrl(
        "https://acme.lightning.force.com/lightning/o/Account/list?filterName=Recent&sid=x",
        target,
      ).url,
    ).toBe(
      target.origins.lightning + "/lightning/o/Account/list?filterName=Recent",
    );
    expect(
      transformUrl(
        "https://acme.lightning.force.com/lightning/o/Account/list?filterName=https://evil.example",
        target,
      ).url,
    ).not.toContain("filterName");
  });
  it.each([
    "/secur/frontdoor.jsp?sid=x",
    "/services/oauth2/authorize",
    "/login",
    "/sso/login",
    "/unknown/path",
  ])("blocks unsafe or unknown route %s", (route) => {
    expect(() =>
      transformUrl("https://acme.my.salesforce.com" + route, target),
    ).toThrow();
  });
  it("requires explicit home for experience, and a configured surface", () => {
    expect(() => transformUrl("https://acme.my.site.com/s", target)).toThrow();
    expect(
      transformUrl("https://acme.my.site.com/s", target, true, "setup").url,
    ).toBe(target.origins.setup + "/");
    expect(() =>
      transformUrl("https://acme.my.salesforce-setup.com/", {
        ...target,
        origins: { lightning: target.origins.lightning },
      }),
    ).toThrow();
  });
  it("warns on record IDs", () => {
    expect(
      transformUrl(
        "https://acme.lightning.force.com/lightning/r/Account/001000000000001AAA/view",
        target,
      ).recordWarning,
    ).toBe(true);
  });
  it("rejects external, mixed-tenant, credential and path origins", () => {
    for (const origin of [
      "https://evil.example",
      "https://other.lightning.force.com",
      "https://user@acme--uat.sandbox.lightning.force.com",
      "https://acme--uat.sandbox.lightning.force.com/",
    ])
      expect(
        switchTargetSchema.safeParse({
          ...target,
          origins: { lightning: origin },
        }).success,
      ).toBe(false);
  });
  it("requires a current preview and per-click production confirmation", async () => {
    const local = new MemoryStorage(),
      session = new MemoryStorage(),
      repo = new Repository(local, session);
    await repo.load();
    const settings = defaultSettings();
    settings.switchTargets = [target];
    settings.tenantPreferences[target.tenantKey] = {
      environment: "production",
    };
    await repo.saveSettings(settings);
    const current = tab(
      1,
      "https://acme.lightning.force.com/lightning/page/home",
    );
    const navigations: string[] = [];
    const switcher = new Switcher(repo, {
      get: async () => structuredClone(current),
      update: async (_id: number, p: chrome.tabs.UpdateProperties) => {
        navigations.push(p.url!);
        return current;
      },
    });
    const a = await switcher.preview(1, "uat", false);
    await expect(switcher.execute(a.id, false)).rejects.toThrow("确认");
    expect(navigations).toEqual([]);
    const b = await switcher.preview(1, "uat", false);
    current.url = "https://acme.lightning.force.com/";
    await expect(switcher.execute(b.id, true)).rejects.toThrow("变化");
    expect(navigations).toEqual([]);
    const c = await switcher.preview(1, "uat", false);
    await switcher.execute(c.id, true);
    expect(navigations).toEqual([target.origins.lightning + "/"]);
  });
});
