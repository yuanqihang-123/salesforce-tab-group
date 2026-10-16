import { initializeLanguage, t } from "../shared/i18n";
import "../shared/ui.css";
import { clearFeedback, el, renderStable, report, run } from "../shared/ui";
import { renderStatus } from "../shared/statusView";
import { request } from "../shared/messaging/client";
import type { Status, SwitchPreview } from "../shared/messaging/contracts";
import {
  switchSurfaceSchema,
  type SwitchTarget,
} from "../shared/models/settings";

const enabled = document.querySelector<HTMLInputElement>("#enabled")!;
const form = document.querySelector<HTMLFormElement>("#switch-form")!;
const target = document.querySelector<HTMLSelectElement>("#target")!;
const home = document.querySelector<HTMLInputElement>("#home")!;
const surface = document.querySelector<HTMLSelectElement>("#surface")!;
const surfaceFields = document.querySelector<HTMLElement>("#surface-fields")!;
const previewButton = document.querySelector<HTMLButtonElement>("#preview")!;
const previewContainer =
  document.querySelector<HTMLElement>("#switch-preview")!;
let status: Status | undefined;
let targets: SwitchTarget[] = [];
let generation = 0;
let refreshGeneration = 0;
let previewBusy = false;
let toggleBusy = false;
let executing = false;
let expiry: ReturnType<typeof setTimeout> | undefined;

function unavailable() {
  return !status?.settings || !!status.degraded || !!status.runtime?.degraded;
}

function updateControls() {
  const empty = !targets.length;
  const reviewing = previewContainer.childElementCount > 0;
  form.hidden = empty || reviewing;
  document.querySelector("#switch-heading")!.textContent = reviewing
    ? t("核对切换")
    : t("切换 Org");
  document.querySelector("#switch-heading + .badge")!.textContent = reviewing
    ? t("确认目标与网址")
    : t("先预览，再切换");
  document.querySelector<HTMLElement>(".section-description")!.hidden =
    reviewing;
  document.querySelector<HTMLElement>("#target-empty")!.hidden = !empty;
  enabled.disabled = unavailable() || toggleBusy;
  target.disabled = empty || unavailable() || executing;
  home.disabled = empty || unavailable() || executing;
  surfaceFields.hidden = !home.checked;
  surface.disabled = !home.checked || target.disabled;
  previewButton.disabled = empty || unavailable() || previewBusy || executing;
  previewButton.textContent = previewBusy
    ? t("正在生成预览…")
    : t("预览切换 →");
  form.setAttribute("aria-busy", String(previewBusy || executing));
}

function updateSurfaces() {
  const selected = surface.value;
  const configured = targets.find((item) => item.id === target.value)?.origins;
  const labels = {
    lightning: "Lightning",
    "my-domain": "My Domain",
    setup: "Setup",
  };
  const available = Object.entries(labels).filter(
    ([value]) => configured?.[value as keyof typeof configured],
  );
  renderStable(
    surface,
    available,
    () => {
      surface.replaceChildren();
      for (const [value, label] of available) {
        const option = el("option", label);
        option.value = value;
        surface.append(option);
      }
      if (
        Array.from(surface.options).some((option) => option.value === selected)
      )
        surface.value = selected;
    },
    surface,
  );
}

function invalidatePreview(restoreFocus = false) {
  generation++;
  clearTimeout(expiry);
  previewBusy = false;
  previewContainer.replaceChildren();
  updateControls();
  if (restoreFocus) previewButton.focus({ preventScroll: true });
}

async function refresh() {
  const refreshId = ++refreshGeneration;
  const next = await request({ type: "status" });
  if (refreshId !== refreshGeneration) return;
  status = next;
  renderStatus(document.querySelector("#status")!, next);
  if (!toggleBusy)
    enabled.checked = next.settings?.autoGroupingEnabled ?? false;
  targets = next.settings?.switchTargets ?? [];
  const selection = target.value;
  renderStable(
    target,
    targets,
    () => {
      target.replaceChildren();
      for (const item of targets) {
        const option = el("option", item.label);
        option.value = item.id;
        target.append(option);
      }
      if (targets.some((item) => item.id === selection))
        target.value = selection;
    },
    target,
  );
  updateSurfaces();
  updateControls();
}

enabled.addEventListener("change", () =>
  run(async () => {
    if (toggleBusy) return;
    toggleBusy = true;
    updateControls();
    clearFeedback();
    try {
      await request({ type: "toggle", enabled: enabled.checked });
      await refresh();
    } finally {
      toggleBusy = false;
      if (status?.settings)
        enabled.checked = status.settings.autoGroupingEnabled;
      updateControls();
    }
  }),
);

for (const id of ["settings", "configure-target"])
  document
    .getElementById(id)!
    .addEventListener("click", () =>
      run(() => chrome.runtime.openOptionsPage()),
    );

for (const input of [target, home, surface])
  input.addEventListener("change", () => {
    if (input === target) updateSurfaces();
    clearFeedback();
    invalidatePreview();
  });

function renderPreview(preview: SwitchPreview, requestGeneration: number) {
  const panel = el("div", undefined, "preview");
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "preview-title");
  const title = el("h3", `${preview.label} · ${preview.environment}`);
  title.id = "preview-title";
  panel.append(
    title,
    el("p", t("将切换当前标签页至："), "field-help"),
    el("p", preview.url, "url"),
  );
  if (preview.recordWarning)
    panel.append(
      el(
        "p",
        t("Record ID、对象或权限可能在目标 Org 中不存在，不执行 ID 映射。"),
        "notice",
      ),
    );
  let confirmation: HTMLInputElement | undefined;
  if (preview.environment === "production") {
    const label = el("label", undefined, "check production-warning");
    confirmation = el("input");
    confirmation.id = "production-confirmation";
    confirmation.type = "checkbox";
    label.append(
      confirmation,
      document.createTextNode(t("确认本次切换至 production（用户标注）")),
    );
    panel.append(label);
  }
  const actions = el("div", undefined, "form-actions");
  const execute = el("button", t("确认并切换当前标签页"));
  execute.type = "button";
  const cancel = el("button", t("取消"), "secondary");
  cancel.id = "cancel-preview";
  cancel.type = "button";
  execute.disabled = !!confirmation;
  confirmation?.addEventListener("change", () => {
    execute.disabled = !confirmation!.checked;
  });
  cancel.addEventListener("click", () => invalidatePreview(true));
  actions.append(execute, cancel);
  panel.append(actions, el("p", t("预览在 2 分钟内有效。"), "field-help"));
  previewContainer.append(panel);
  updateControls();
  // Stop on the acknowledgement/cancel control; Enter used to preview cannot execute.
  (confirmation ?? cancel).focus({ preventScroll: true });
  (confirmation ?? cancel).scrollIntoView({ block: "nearest" });
  expiry = setTimeout(() => {
    if (requestGeneration !== generation || executing) return;
    const focused = previewContainer.contains(document.activeElement);
    invalidatePreview(focused);
    report(new Error(t("预览已过期，请重新预览。")));
  }, 120_000);
  execute.addEventListener("click", () =>
    run(async () => {
      if (executing || requestGeneration !== generation) return;
      executing = true;
      execute.disabled = true;
      cancel.disabled = true;
      if (confirmation) confirmation.disabled = true;
      updateControls();
      clearFeedback();
      try {
        await request({
          type: "execute-switch",
          id: preview.id,
          confirmedProduction: confirmation?.checked ?? false,
        });
        window.close();
      } catch (error) {
        // Execution tokens are consumed by the worker; retry from a fresh preview.
        invalidatePreview();
        report(error);
      } finally {
        executing = false;
        updateControls();
        if (!previewContainer.childElementCount)
          previewButton.focus({ preventScroll: true });
      }
    }),
  );
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (previewButton.disabled) return;
  invalidatePreview();
  const requestGeneration = generation;
  const input = {
    targetId: target.value,
    home: home.checked,
    surface: surface.value,
  };
  previewBusy = true;
  updateControls();
  clearFeedback();
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (requestGeneration !== generation) return;
      if (tab?.id === undefined) throw new Error(t("无法读取当前标签页。"));
      const preview = await request({
        type: "preview-switch",
        tabId: tab.id,
        targetId: input.targetId,
        home: input.home,
        ...(input.home
          ? { surface: switchSurfaceSchema.parse(input.surface) }
          : {}),
      });
      if (requestGeneration !== generation) return;
      renderPreview(preview, requestGeneration);
    } catch (error) {
      if (requestGeneration === generation) report(error);
    } finally {
      if (requestGeneration === generation) {
        previewBusy = false;
        updateControls();
      }
    }
  })();
});

document.addEventListener("keydown", (event) => {
  // Native select menus own Escape, including on the minimum Chrome version.
  if (event.target instanceof HTMLSelectElement) return;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  if (
    event.key !== "Escape" ||
    executing ||
    (!previewBusy && !previewContainer.childElementCount)
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  clearFeedback();
  invalidatePreview(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const focused = previewContainer.contains(document.activeElement);
    invalidatePreview(focused);
    run(refresh);
  } else if (area === "session" && changes.runtime) run(refresh);
});
run(async () => {
  await initializeLanguage(() => {
    clearFeedback();
    invalidatePreview(previewContainer.contains(document.activeElement));
    run(refresh);
  });
  await refresh();
});
