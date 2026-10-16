import { describe, expect, it } from "vitest";
import { parseTabTenant } from "../src/shared/salesforce/tabTenant";
import { parseSalesforceUrl } from "../src/shared/salesforce/urlParser";

const base = "chrome-extension://nobhcglociplekefjfpeaajecldpjlmn";
const host = "casecentral--uatpes.sandbox.my.salesforce.com";
describe("Inspector tab tenant", () => {
  it.each(["inspect", "data-export", "data-import", "explore-api"])(
    "resolves %s pages using the Salesforce host",
    (page) => {
      const url = `${base}/${page}.html?host=${host}&objectType=Account`;
      expect(parseTabTenant(url)).toMatchObject({
        kind: "supported",
        tenantKey: "sf:commercial:sandbox:casecentral--uatpes",
      });
      expect(parseSalesforceUrl(url).kind).not.toBe("supported");
    },
  );
  it.each([
    "aodjmnfhjibkcdimpodiifdjnnncaafh",
    "hpijlohoihegkfehhibggnkbjhoemldh",
  ])("recognizes store release %s", (id) => {
    expect(
      parseTabTenant(`chrome-extension://${id}/inspect.html?host=${host}`).kind,
    ).toBe("supported");
  });
  it.each([
    "",
    "evil.example",
    `${host}.evil.example`,
    `https://${host}`,
    `${host}/path`,
    `${host}:443`,
    `user@${host}`,
    `${host}%23fragment`,
    "login.salesforce.com",
    "acme--uatpes.my.salesforce.com",
    `${host}&host=other.my.salesforce.com`,
  ])("rejects missing, ambiguous or non-host values: %s", (value) => {
    expect(parseTabTenant(`${base}/inspect.html?host=${value}`).kind).not.toBe(
      "supported",
    );
  });
  it.each([
    `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/inspect.html?host=${host}`,
    `https://example.com/inspect.html?host=${host}`,
    `${base}/?host=${host}`,
    `${base}/inspector.js?host=${host}`,
    `${base}/inspect.html?retURL=${host}`,
  ])("does not infer tenants from unrelated URLs: %s", (url) => {
    expect(parseTabTenant(url).kind).not.toBe("supported");
  });
});
