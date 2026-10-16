import type { Coordinator } from "./coordinator";
export function registerEvents(c: Coordinator) {
  const safe = (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  };
  chrome.runtime.onInstalled.addListener(() => safe(c.scan()));
  chrome.runtime.onStartup.addListener(() => safe(c.scan()));
  chrome.tabs.onCreated.addListener((tab) => c.mark(tab.windowId));
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (
      ["url", "status", "pinned", "groupId", "splitViewId"].some(
        (k) => k in change,
      )
    )
      c.mark(tab.windowId);
  });
  chrome.tabs.onAttached.addListener((id, info) =>
    c.attached(id, info.newWindowId),
  );
  chrome.tabs.onDetached.addListener((id, info) =>
    c.detached(id, info.oldWindowId),
  );
  chrome.tabs.onMoved.addListener((_id, info) => c.mark(info.windowId));
  chrome.tabs.onRemoved.addListener((id, info) =>
    safe(c.removed(id, info.windowId)),
  );
  chrome.tabs.onReplaced.addListener((added, removed) =>
    safe(c.replaced(added, removed)),
  );
  chrome.tabs.onActivated.addListener((info) => c.mark(info.windowId));
  for (const event of [
    chrome.tabGroups.onCreated,
    chrome.tabGroups.onUpdated,
    chrome.tabGroups.onMoved,
    chrome.tabGroups.onRemoved,
  ])
    event.addListener((group) => c.mark(group.windowId));
  chrome.windows.onCreated.addListener((w) => {
    if (w.id !== undefined) c.mark(w.id);
  });
  chrome.windows.onRemoved.addListener((id) => c.mark(id));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "sfn-reconcile") safe(c.scan());
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) safe(c.settingsChanged());
  });
}
