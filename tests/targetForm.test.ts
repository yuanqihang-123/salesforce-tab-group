import { describe, expect, it } from "vitest";
import { parseTargetInput } from "../src/features/org-switcher/targetInput";

describe("switch target form input", () => {
  it("trims fields, omits blank origins and infers the tenant from a configured surface", () => {
    expect(
      parseTargetInput({
        id: "uat",
        label: "  UAT  ",
        origins: {
          lightning: "  ",
          "my-domain": " https://acme--uat.sandbox.my.salesforce.com ",
          setup: "https://acme--uat.sandbox.my.salesforce-setup.com",
        },
      }),
    ).toEqual({
      id: "uat",
      label: "UAT",
      tenantKey: "sf:commercial:sandbox:acme--uat",
      origins: {
        "my-domain": "https://acme--uat.sandbox.my.salesforce.com",
        setup: "https://acme--uat.sandbox.my.salesforce-setup.com",
      },
    });
  });

  it("requires at least one nonblank origin", () => {
    expect(() =>
      parseTargetInput({
        id: "uat",
        label: "UAT",
        origins: { lightning: " " },
      }),
    ).toThrow("请至少配置一个 origin");
  });

  it.each([
    { lightning: "https://evil.example" },
    { lightning: "https://acme.my.salesforce.com" },
    { lightning: "https://acme.lightning.force.com/" },
    { lightning: "https://user@acme.lightning.force.com" },
    {
      lightning: "https://acme.lightning.force.com",
      setup: "https://other.my.salesforce-setup.com",
    },
  ])("uses the target schema to reject invalid origins: %s", (origins) => {
    expect(() =>
      parseTargetInput({ id: "uat", label: "UAT", origins }),
    ).toThrow("请填写同一个 tenant 的精确 HTTPS origin");
  });

  it("validates the target name using the shared schema", () => {
    expect(() =>
      parseTargetInput({
        id: "uat",
        label: " ",
        origins: { lightning: "https://acme.lightning.force.com" },
      }),
    ).toThrow("配置未通过校验");
  });
});
