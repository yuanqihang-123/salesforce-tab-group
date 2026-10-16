import { settingsSchema } from "../shared/models/settings";
import type {
  CommandResult,
  SettingsCommand,
} from "../shared/messaging/contracts";
import type { Repository } from "../shared/storage/repository";

// The application handler runs this read/modify/write in the coordinator queue.
export async function applySettingsCommand(
  repo: Repository,
  command: SettingsCommand,
): Promise<CommandResult> {
  await repo.freshSettings();
  const next = structuredClone(repo.settings);
  switch (command.type) {
    case "toggle":
      next.autoGroupingEnabled = command.enabled;
      break;
    case "exclude-tenant":
      next.excludedTenants = next.excludedTenants.filter(
        (key) => key !== command.key,
      );
      if (command.excluded) next.excludedTenants.push(command.key);
      break;
    case "tenant-settings":
      next.tenantPreferences[command.key] = command.preference;
      next.excludedTenants = next.excludedTenants.filter(
        (key) => key !== command.key,
      );
      if (command.excluded) next.excludedTenants.push(command.key);
      break;
    case "preference":
      next.tenantPreferences[command.key] = command.preference;
      break;
    case "save-target":
      next.switchTargets = next.switchTargets.filter(
        (target) => target.id !== command.target.id,
      );
      next.switchTargets.push(command.target);
      break;
    case "remove-target":
      next.switchTargets = next.switchTargets.filter(
        (target) => target.id !== command.id,
      );
      break;
  }
  const before = JSON.stringify({ ...repo.settings, revision: 0 });
  if (JSON.stringify({ ...next, revision: 0 }) !== before) {
    next.revision++;
    await repo.saveSettings(settingsSchema.parse(next));
  }
  return { ok: true };
}
