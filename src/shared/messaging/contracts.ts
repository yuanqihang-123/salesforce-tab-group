import { z } from "zod/v3";
import {
  preferenceSchema,
  switchSurfaceSchema,
  switchTargetSchema,
  tenantKeySchema,
  type Settings,
} from "../models/settings";
import type { Runtime } from "../models/runtime";

export const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tenant-settings"),
      key: tenantKeySchema,
      preference: preferenceSchema,
      excluded: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("status") }).strict(),
  z.object({ type: z.literal("toggle"), enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("exclude-tenant"),
      key: tenantKeySchema,
      excluded: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("preference"),
      key: tenantKeySchema,
      preference: preferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("restore-tab"),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ type: z.literal("save-target"), target: switchTargetSchema })
    .strict(),
  z.object({ type: z.literal("remove-target"), id: z.string() }).strict(),
  z
    .object({
      type: z.literal("preview-switch"),
      tabId: z.number().int().nonnegative(),
      targetId: z.string(),
      home: z.boolean(),
      surface: switchSurfaceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execute-switch"),
      id: z.string(),
      confirmedProduction: z.boolean(),
    })
    .strict(),
]);

export type Message = z.infer<typeof messageSchema>;
export type MessageOf<T extends Message["type"]> = Extract<
  Message,
  { type: T }
>;
export type SettingsCommand = Exclude<
  Message,
  { type: "status" | "restore-tab" | "preview-switch" | "execute-switch" }
>;
export interface Status {
  settings: Settings | null;
  runtime: Runtime | null;
  degraded: string | null;
}
export interface SwitchPreview {
  id: string;
  url: string;
  label: string;
  environment: string;
  recordWarning: boolean;
}
export interface CommandResult {
  ok: true;
}
export interface ResponseMap {
  status: Status;
  "preview-switch": SwitchPreview;
  "execute-switch": CommandResult;
  "restore-tab": CommandResult;
  toggle: CommandResult;
  "exclude-tenant": CommandResult;
  "tenant-settings": CommandResult;
  preference: CommandResult;
  "save-target": CommandResult;
  "remove-target": CommandResult;
}
export type ResponseFor<M extends Message> = ResponseMap[M["type"]];
export type ResponseEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: string };
export type MessageHandlers = {
  [T in Message["type"]]: (message: MessageOf<T>) => Promise<ResponseMap[T]>;
};
