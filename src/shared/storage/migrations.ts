import { defaultSettings, settingsSchema } from "../models/settings";
// V1 has no older schema. Never reset unknown/corrupt data to defaults.
export function migrateSettings(raw: unknown) {
  return raw === undefined ? defaultSettings() : settingsSchema.parse(raw);
}
