import { z } from "zod/v3";
import {
  isTenantKey,
  parseSalesforceUrl,
  type TenantKey,
} from "../salesforce/urlParser";
export const tenantKeySchema = z
  .string()
  .refine(isTenantKey)
  .transform((v) => v as TenantKey);
export const preferenceSchema = z
  .object({
    alias: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((v) => !v.includes("[SFN:"))
      .optional(),
    environment: z
      .enum(["production", "sandbox", "development", "unknown"])
      .optional(),
  })
  .strict();
export const switchSurfaceSchema = z.enum(["my-domain", "lightning", "setup"]);
export type SwitchSurface = z.infer<typeof switchSurfaceSchema>;
export const switchTargetSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(80),
    tenantKey: tenantKeySchema,
    origins: z
      .object({
        "my-domain": z.string().optional(),
        lightning: z.string().optional(),
        setup: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!Object.keys(t.origins).length)
      ctx.addIssue({ code: "custom", message: "至少配置一个 origin" });
    for (const [surface, origin] of Object.entries(t.origins)) {
      let exact = false;
      try {
        exact = new URL(origin).origin === origin;
      } catch {
        /* invalid URL */
      }
      const p = parseSalesforceUrl(origin);
      if (
        !exact ||
        p.kind !== "supported" ||
        p.tenantKey !== t.tenantKey ||
        p.surface !== surface
      )
        ctx.addIssue({
          code: "custom",
          message: "目标须为相同 tenant、匹配 surface 的精确 HTTPS origin",
        });
    }
  });
export const settingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    autoGroupingEnabled: z.boolean(),
    respectUserGroups: z.literal(true),
    skipPinnedTabs: z.literal(true),
    excludedTenants: z.array(tenantKeySchema).max(1000),
    tenantPreferences: z.record(tenantKeySchema, preferenceSchema),
    switchTargets: z.array(switchTargetSchema).max(100),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.switchTargets.map((t) => t.id)).size === s.switchTargets.length,
    { message: "目标 ID 重复" },
  );
export type Settings = z.infer<typeof settingsSchema>;
export type SwitchTarget = z.infer<typeof switchTargetSchema>;
export const defaultSettings = (): Settings => ({
  schemaVersion: 1,
  revision: 0,
  autoGroupingEnabled: true,
  respectUserGroups: true,
  skipPinnedTabs: true,
  excludedTenants: [],
  tenantPreferences: {},
  switchTargets: [],
});
