import { Coordinator } from "./coordinator";
import { registerEvents } from "./eventRouter";
import { createMessageHandlers } from "./messageHandlers";
import { registerMessageRouter } from "./messageRouter";
import { Repository } from "../shared/storage/repository";
import { browserAdapter } from "../shared/chrome/browserAdapter";
import { Switcher } from "../features/org-switcher/switcher";

const repo = new Repository(chrome.storage.local, chrome.storage.session);
const coordinator = new Coordinator(browserAdapter, repo, async (enabled) => {
  const alarm = await chrome.alarms.get("sfn-reconcile");
  if (enabled && (!alarm || alarm.periodInMinutes !== 1))
    await chrome.alarms.create("sfn-reconcile", { periodInMinutes: 1 });
  if (!enabled && alarm) await chrome.alarms.clear("sfn-reconcile");
});
const switcher = new Switcher(repo, chrome.tabs);

// All listeners are registered synchronously, before bootstrap awaits resolve.
registerEvents(coordinator);
registerMessageRouter(createMessageHandlers(coordinator, repo, switcher));
