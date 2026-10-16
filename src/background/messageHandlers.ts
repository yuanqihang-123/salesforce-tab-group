import type { Switcher } from "../features/org-switcher/switcher";
import type {
  MessageHandlers,
  SettingsCommand,
} from "../shared/messaging/contracts";
import type { Repository } from "../shared/storage/repository";
import type { Coordinator } from "./coordinator";
import { applySettingsCommand } from "./settingsCommands";

export function createMessageHandlers(
  coordinator: Coordinator,
  repo: Repository,
  switcher: Switcher,
): MessageHandlers {
  const command = <T>(task: () => Promise<T>) =>
    coordinator.serial(async () => {
      if (coordinator.degraded)
        throw new Error(
          "存储或权限异常，已停止变更。请检查扩展权限和本地数据。",
        );
      return task();
    });
  const settingsCommand = (message: SettingsCommand) =>
    command(() => applySettingsCommand(repo, message));

  return {
    status: () =>
      coordinator.serial(async () => ({
        settings: repo.settings ?? null,
        runtime: repo.runtime ?? null,
        degraded: coordinator.degraded ?? null,
      })),
    "preview-switch": (message) =>
      command(() =>
        switcher.preview(
          message.tabId,
          message.targetId,
          message.home,
          message.surface,
        ),
      ),
    "execute-switch": (message) =>
      command(() => switcher.execute(message.id, message.confirmedProduction)),
    "restore-tab": async (message) => {
      // restoreTab owns its queue entry; wrapping it in command would deadlock.
      await coordinator.restoreTab(message.tabId);
      return { ok: true };
    },
    toggle: settingsCommand,
    "exclude-tenant": settingsCommand,
    "tenant-settings": settingsCommand,
    preference: settingsCommand,
    "save-target": settingsCommand,
    "remove-target": settingsCommand,
  };
}
