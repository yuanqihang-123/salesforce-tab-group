export type Tab = chrome.tabs.Tab & { splitViewId?: number };
export type Group = chrome.tabGroups.TabGroup & { shared?: boolean };
export interface Snapshot {
  tabs: Tab[];
  groups: Group[];
  windows: chrome.windows.Window[];
}
