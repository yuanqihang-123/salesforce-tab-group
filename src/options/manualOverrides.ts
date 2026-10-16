import { t } from "../shared/i18n";
import { request } from "../shared/messaging/client";
import type { Runtime } from "../shared/models/runtime";
import {
  clearFeedback,
  el,
  renderStable,
  run,
  setFeedback,
} from "../shared/ui";

export function createManualOverrides(onChange: () => Promise<void>) {
  const container = document.getElementById("overrides")!;
  const pending = new Set<number>();
  return {
    render(runtime: Runtime | null) {
      const overrides = Object.values(runtime?.overrides ?? {}).map(
        (override) => ({
          tabId: override.tabId,
          host:
            runtime?.observations[override.tabId]?.host ?? t("URL 暂不可读"),
        }),
      );
      renderStable(
        container,
        overrides,
        () => {
          container.replaceChildren();
          for (const override of overrides) {
            const row = el("div", undefined, "item");
            const heading = el("div", undefined, "item-heading");
            heading.append(
              el("strong", t("标签页 {p0}", { p0: override.tabId })),
            );
            row.append(heading, el("div", override.host, "identity"));
            const actions = el("div", undefined, "item-actions");
            const button = el("button", t("恢复自动管理"), "secondary");
            button.type = "button";
            button.dataset.focusKey = `restore-tab:${override.tabId}`;
            button.setAttribute(
              "aria-label",
              t("恢复标签页 {p0} 的自动管理", { p0: override.tabId }),
            );
            button.disabled = pending.has(override.tabId);
            if (button.disabled) button.textContent = t("恢复中…");
            button.addEventListener("click", () => {
              if (pending.has(override.tabId)) return;
              const index = Array.from(
                container.querySelectorAll("button"),
              ).indexOf(button);
              let focusMoved = document.activeElement !== button;
              const trackFocus = (event: FocusEvent) => {
                if (event.target !== button && event.target !== document.body)
                  focusMoved = true;
              };
              const trackPointer = (event: PointerEvent) => {
                if (event.target !== button) focusMoved = true;
              };
              document.addEventListener("focusin", trackFocus);
              document.addEventListener("pointerdown", trackPointer, true);
              pending.add(override.tabId);
              button.disabled = true;
              button.textContent = t("恢复中…");
              clearFeedback();
              run(async () => {
                let restored = false;
                try {
                  await request({ type: "restore-tab", tabId: override.tabId });
                  restored = true;
                  setFeedback(`标签页 ${override.tabId} 已恢复自动管理。`);
                  await onChange();
                } finally {
                  pending.delete(override.tabId);
                  const current = Array.from(
                    container.querySelectorAll<HTMLButtonElement>(
                      "[data-focus-key]",
                    ),
                  ).find(
                    (node) => node.dataset.focusKey === button.dataset.focusKey,
                  );
                  if (current) {
                    current.disabled = false;
                    current.textContent = t("恢复自动管理");
                  }
                  document.removeEventListener("focusin", trackFocus);
                  document.removeEventListener(
                    "pointerdown",
                    trackPointer,
                    true,
                  );
                  if (!focusMoved) {
                    const remaining = Array.from(
                      container.querySelectorAll<HTMLButtonElement>(
                        "[data-focus-key]",
                      ),
                    ).filter((node) => !node.disabled && node !== current);
                    const next =
                      !restored && current
                        ? current
                        : (remaining[Math.min(index, remaining.length - 1)] ??
                          document.getElementById("manual-overrides"));
                    next?.focus({ preventScroll: true });
                  }
                }
              });
            });
            actions.append(button);
            row.append(actions);
            container.append(row);
          }
          if (!container.childElementCount)
            container.append(
              el("p", t("没有手动排除的标签页。"), "empty-state"),
            );
        },
        document.querySelector<HTMLElement>("#manual-overrides") ?? undefined,
      );
    },
  };
}
