import {
  ownershipSchema,
  runtimeSchema,
  defaultRuntime,
  type Runtime,
  type Registration,
} from "../models/runtime";
import { settingsSchema, type Settings } from "../models/settings";
import { migrateSettings } from "./migrations";
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
export class StorageFailure extends Error {
  constructor() {
    super("存储不可用或数据校验失败，已停止自动变更。");
  }
}
export class Repository {
  settings!: Settings;
  runtime!: Runtime;
  ownership: Registration[] = [];
  constructor(
    private local: StorageArea,
    private session: StorageArea,
  ) {}
  private async checked<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch {
      throw new StorageFailure();
    }
  }
  async load() {
    return this.checked(async () => {
      const [l, s] = await Promise.all([
        this.local.get(["settings", "ownership"]),
        this.session.get(["runtime"]),
      ]);
      this.settings = migrateSettings(l.settings);
      this.ownership = ownershipSchema.parse(
        l.ownership === undefined ? [] : l.ownership,
      );
      this.runtime =
        s.runtime === undefined
          ? defaultRuntime()
          : runtimeSchema.parse(s.runtime);
      if (l.settings === undefined)
        await this.local.set({ settings: this.settings });
    });
  }
  async freshSettings() {
    return this.checked(async () => {
      const { settings } = await this.local.get(["settings"]);
      this.settings = settingsSchema.parse(settings);
      return this.settings;
    });
  }
  async saveSettings(next: Settings) {
    return this.checked(async () => {
      const validated = settingsSchema.parse(next);
      await this.local.set({ settings: validated });
      this.settings = validated;
    });
  }
  async saveRuntime() {
    return this.checked(async () => {
      await this.session.set({ runtime: runtimeSchema.parse(this.runtime) });
    });
  }
  async saveOwnership() {
    return this.checked(async () => {
      await this.local.set({
        ownership: ownershipSchema.parse(this.ownership),
      });
    });
  }
}
