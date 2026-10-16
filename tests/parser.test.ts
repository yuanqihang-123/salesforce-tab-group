import { describe, it, expect } from "vitest";
import {
  parseSalesforceUrl,
  partitions,
  suffixes,
  verifiedSurfaces,
} from "../src/shared/salesforce/urlParser";
import { inferredEnvironment } from "../src/shared/salesforce/tenantResolver";
import { supportedFixtures, negativeFixtures } from "./fixtures/urls";
describe("strict Salesforce parser", () => {
  it.each(supportedFixtures)("$url", ({ url, key, surface }) => {
    expect(parseSalesforceUrl(url)).toMatchObject({
      kind: "supported",
      tenantKey: key,
      surface,
    });
  });
  it.each(negativeFixtures)("rejects %s", (url) => {
    expect(parseSalesforceUrl(url).kind).not.toBe("supported");
  });
  it("all enabled partition/surface combinations have explicit fixtures", () => {
    for (const p of partitions)
      for (const s of verifiedSurfaces[p])
        expect(
          supportedFixtures.some(
            (f) => f.key.includes(`:${p}:`) && f.surface === s,
          ),
        ).toBe(true);
    expect(Object.keys(suffixes)).toHaveLength(4);
  });
  it("normalizes case and one root dot", () => {
    expect(
      parseSalesforceUrl("https://ACME.LIGHTNING.FORCE.COM.:443/a?x=1#z"),
    ).toMatchObject({
      kind: "supported",
      tenantKey: "sf:commercial:unpartitioned:acme",
    });
    expect(
      parseSalesforceUrl("https://acme.lightning.force.com..").kind,
    ).not.toBe("supported");
  });
  it("does not infer production", () => {
    expect(inferredEnvironment("sf:commercial:unpartitioned:acme")).toBe(
      "unknown",
    );
  });
  it("does not merge sandbox labels, namespace partitions or site paths", () => {
    const get = (url: string) => {
      const p = parseSalesforceUrl(url);
      return p.kind === "supported" ? p.tenantKey : undefined;
    };
    expect(get("https://acme--dev.sandbox.lightning.force.com")).not.toBe(
      get("https://other--dev.sandbox.lightning.force.com"),
    );
    expect(get("https://acme.develop.my.salesforce.com")).not.toBe(
      get("https://acme.my.salesforce.com"),
    );
    expect(get("https://acme.my.site.com/a/s")).toBe(
      get("https://acme.my.site.com/b/s"),
    );
  });
});
