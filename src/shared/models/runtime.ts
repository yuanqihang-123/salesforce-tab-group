import { z } from "zod/v3";
import { tenantKeySchema } from "./settings";
const id = z.number().int().nonnegative();
const token = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
export const ownershipSchema = z
  .array(
    z
      .object({
        token,
        tenantKey: tenantKeySchema,
        status: z.enum(["active", "released"]),
        createdAt: z.number(),
        releaseReason: z.string().max(80).optional(),
      })
      .strict(),
  )
  .refine((a) => new Set(a.map((r) => r.token)).size === a.length);
export type Registration = z.infer<typeof ownershipSchema>[number];
const observationSchema = z
  .object({
    windowId: id,
    groupId: z.number().int(),
    host: z.string(),
    identity: z.string(),
    pinned: z.boolean(),
    settled: z.boolean(),
    stableSince: z.number(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;
const bindingSchema = z
  .object({
    windowId: id,
    groupId: id,
    tenantKey: tenantKeySchema,
    token,
    status: z.enum(["verified", "recovering"]),
    since: z.number(),
  })
  .strict();
export type Binding = z.infer<typeof bindingSchema>;
const intentSchema = z
  .object({
    operationId: z.string(),
    kind: z.enum(["create", "join", "ungroup", "metadata"]),
    windowId: id,
    tenantKey: tenantKeySchema.optional(),
    token: token.optional(),
    tabIds: z.array(id),
    targetGroupId: id.optional(),
    expectedBefore: z.record(z.string(), observationSchema),
    settingsRevision: z.number().int(),
    phase: z.enum(["prepared", "applied", "verified"]),
    expiresAt: z.number(),
    appearance: z
      .object({
        title: z.string(),
        color: z.enum([
          "grey",
          "blue",
          "red",
          "yellow",
          "green",
          "pink",
          "purple",
          "cyan",
          "orange",
        ]),
        collapsed: z.boolean(),
      })
      .optional(),
  })
  .strict();
export type Intent = z.infer<typeof intentSchema>;
export const runtimeSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindings: z.array(bindingSchema),
    overrides: z.record(
      z.string(),
      z
        .object({
          tabId: id,
          reason: z.enum([
            "manual-ungroup",
            "manual-regroup",
            "uncertain-replacement",
          ]),
          createdAt: z.number(),
        })
        .strict(),
    ),
    observations: z.record(z.string(), observationSchema),
    dirty: z.array(id),
    intents: z.array(intentSchema),
    retries: z.record(
      z.string(),
      z
        .object({
          attempts: z.number().int().nonnegative(),
          nextEligibleAt: z.number(),
          fingerprint: z.string().optional(),
        })
        .strict(),
    ),
    reasons: z.record(z.string(), z.number().nonnegative()),
    lastScan: z.number(),
    degraded: z.string().optional(),
  })
  .strict();
export type Runtime = z.infer<typeof runtimeSchema>;
export const defaultRuntime = (): Runtime => ({
  schemaVersion: 1,
  bindings: [],
  overrides: {},
  observations: {},
  dirty: [],
  intents: [],
  retries: {},
  reasons: {},
  lastScan: 0,
});
