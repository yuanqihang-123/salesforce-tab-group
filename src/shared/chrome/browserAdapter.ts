import type { Snapshot, Tab, Group } from "./types";
export interface BrowserAdapter {
  snapshot(): Promise<Snapshot>;
  tab(id: number): Promise<Tab>;
  group(id: number): Promise<Group>;
  create(tabIds: number[], windowId: number): Promise<number>;
  join(tabIds: number[], groupId: number): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  metadata(
    groupId: number,
    properties: chrome.tabGroups.UpdateProperties,
  ): Promise<unknown>;
}
export const browserAdapter: BrowserAdapter = {
  async snapshot() {
    const [windows, groups] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      chrome.tabGroups.query({}),
    ]);
    return { windows, tabs: windows.flatMap((w) => w.tabs ?? []), groups };
  },
  tab: (id) => chrome.tabs.get(id),
  group: (id) => chrome.tabGroups.get(id),
  create: (tabIds, windowId) =>
    chrome.tabs.group({
      tabIds: nonEmpty(tabIds),
      createProperties: { windowId },
    }),
  join: (tabIds, groupId) =>
    chrome.tabs.group({ tabIds: nonEmpty(tabIds), groupId }),
  ungroup: (tabIds) => chrome.tabs.ungroup(nonEmpty(tabIds)),
  metadata: (id, p) => chrome.tabGroups.update(id, p),
};

function nonEmpty(ids: number[]): [number, ...number[]] {
  if (!ids.length) throw new Error("Empty tab batch");
  return [ids[0]!, ...ids.slice(1)];
}
