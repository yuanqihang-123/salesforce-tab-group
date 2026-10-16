import type { Runtime } from "../../shared/models/runtime";
export function excludeTab(
  runtime: Runtime,
  tabId: number,
  reason: "manual-ungroup" | "manual-regroup" | "uncertain-replacement",
) {
  runtime.overrides[tabId] = { tabId, reason, createdAt: Date.now() };
}
