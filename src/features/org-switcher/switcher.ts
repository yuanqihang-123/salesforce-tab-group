import type { Tab } from "../../shared/chrome/types";
import type { Repository } from "../../shared/storage/repository";
import type { SwitchSurface } from "../../shared/models/settings";
import { transformUrl } from "./urlTransformer";
export interface Preview {
  id: string;
  tabId: number;
  targetId: string;
  url: string;
  label: string;
  environment: string;
  recordWarning: boolean;
  expiresAt: number;
  source: string;
  revision: number;
}
// Full source URL exists only in worker memory, never persisted or logged.
export class Switcher {
  private previews = new Map<string, Preview>();
  constructor(
    private repo: Repository,
    private tabs: {
      get(id: number): Promise<Tab>;
      update(id: number, properties: { url: string }): Promise<Tab | undefined>;
    },
  ) {}
  async preview(
    tabId: number,
    targetId: string,
    home: boolean,
    surface?: SwitchSurface,
  ) {
    await this.repo.freshSettings();
    const tab = await this.tabs.get(tabId),
      target = this.repo.settings.switchTargets.find((t) => t.id === targetId);
    if (
      !target ||
      !tab.url ||
      tab.incognito ||
      (tab.pendingUrl && tab.pendingUrl !== tab.url)
    )
      throw new Error("标签页或目标已变化，请重试。");
    const result = transformUrl(tab.url, target, home, surface);
    const preview: Preview = {
      ...result,
      id: crypto.randomUUID(),
      tabId,
      targetId,
      label: target.label,
      environment:
        this.repo.settings.tenantPreferences[target.tenantKey]?.environment ??
        "unknown",
      expiresAt: Date.now() + 120_000,
      source: tab.url,
      revision: this.repo.settings.revision,
    };
    for (const [id, p] of this.previews)
      if (p.expiresAt < Date.now()) this.previews.delete(id);
    if (this.previews.size > 20) this.previews.clear();
    this.previews.set(preview.id, preview);
    return {
      id: preview.id,
      url: preview.url,
      label: preview.label,
      environment: preview.environment,
      recordWarning: preview.recordWarning,
    };
  }
  async execute(id: string, confirmedProduction: boolean) {
    const preview = this.previews.get(id);
    if (!preview || preview.expiresAt < Date.now())
      throw new Error("预览已过期，请重新预览。");
    await this.repo.freshSettings();
    const tab = await this.tabs.get(preview.tabId);
    if (
      tab.url !== preview.source ||
      tab.incognito ||
      (tab.pendingUrl && tab.pendingUrl !== tab.url) ||
      this.repo.settings.revision !== preview.revision
    )
      throw new Error("页面或配置已变化，请重新预览。");
    if (preview.environment === "production" && !confirmedProduction)
      throw new Error("请确认本次 production 切换。");
    this.previews.delete(id);
    await this.tabs.update(preview.tabId, { url: preview.url });
    return { ok: true } as const;
  }
}
