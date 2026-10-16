import { t } from "../shared/i18n";
import { request } from "../shared/messaging/client";
import type { Status } from "../shared/messaging/contracts";
import { preferenceSchema } from "../shared/models/settings";
import {
  parseSalesforceUrl,
  type TenantKey,
} from "../shared/salesforce/urlParser";
import {
  clearFeedback,
  el,
  renderStable,
  run,
  setFeedback,
} from "../shared/ui";

export function createTenantPreferences(onChange: () => Promise<void>) {
  const form = document.getElementById("tenant-form") as HTMLFormElement;
  const container = document.getElementById("tenants")!;
  const url = document.getElementById("tenant-url") as HTMLInputElement;
  const alias = document.getElementById("alias") as HTMLInputElement;
  const environment = document.getElementById(
    "environment",
  ) as HTMLSelectElement;
  const excluded = document.getElementById("excluded") as HTMLInputElement;
  const cancel = document.getElementById(
    "cancel-tenant-edit",
  ) as HTMLButtonElement;
  const save = document.getElementById("save-tenant") as HTMLButtonElement;
  const title = document.getElementById("tenant-form-title")!;
  const feedback = document.getElementById("tenant-feedback");
  const inputs = [url, alias, environment];
  let editKey: TenantKey | undefined;
  let pending = false;
  let composing = false;
  let disabledControls: [
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
    boolean,
  ][] = [];

  function clearInvalid() {
    for (const input of inputs) {
      input.removeAttribute("aria-invalid");
      const descriptions = (input.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((id) => id && id !== feedback?.id);
      if (descriptions.length)
        input.setAttribute("aria-describedby", descriptions.join(" "));
      else input.removeAttribute("aria-describedby");
    }
  }

  function invalid(
    input: HTMLInputElement | HTMLSelectElement,
    message: string,
  ) {
    setFeedback(message, "error", feedback);
    input.setAttribute("aria-invalid", "true");
    if (feedback) {
      const descriptions = new Set(
        (input.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean),
      );
      descriptions.add(feedback.id);
      input.setAttribute("aria-describedby", [...descriptions].join(" "));
    }
    input.focus();
  }

  function updateEditingState() {
    title.textContent = editKey ? t("编辑组织偏好") : t("添加 Org 偏好");
    cancel.hidden = !editKey;
    save.textContent = pending
      ? t("处理中…")
      : editKey
        ? t("保存修改")
        : t("保存偏好");
  }

  function reset() {
    editKey = undefined;
    form.reset();
    clearInvalid();
    clearFeedback(feedback);
    updateEditingState();
  }

  function setPending(value: boolean) {
    pending = value;
    form.setAttribute("aria-busy", String(value));
    if (value) {
      disabledControls = Array.from(
        form.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >("input, select, button"),
      ).map((control) => [control, control.disabled]);
      for (const [control] of disabledControls) control.disabled = true;
    } else {
      for (const [control, disabled] of disabledControls)
        control.disabled = disabled;
      disabledControls = [];
    }
    for (const button of Array.from(container.querySelectorAll("button")))
      button.disabled = value;
    updateEditingState();
  }

  function focusEdit(key: TenantKey | undefined) {
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-focus-key]"),
    ).find((node) => node.dataset.focusKey === `tenant-edit:${key}`);
    (button ?? url).focus();
  }

  function cancelEditing() {
    if (pending || !editKey) return;
    const previousKey = editKey;
    reset();
    focusEdit(previousKey);
  }

  cancel.addEventListener("click", cancelEditing);
  form.addEventListener("compositionstart", () => {
    composing = true;
  });
  form.addEventListener("compositionend", () => {
    composing = false;
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      event.preventDefault();
      return;
    }
    if (
      event.key === "Escape" &&
      !(event.target instanceof HTMLSelectElement) &&
      !composing &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.defaultPrevented &&
      editKey &&
      !pending
    ) {
      event.preventDefault();
      cancelEditing();
    }
  });
  for (const input of [...inputs, excluded])
    input.addEventListener("input", () => {
      clearInvalid();
      clearFeedback(feedback);
    });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending || composing) return;
    clearInvalid();
    clearFeedback(feedback);
    const parsed = parseSalesforceUrl(url.value.trim());
    if (parsed.kind !== "supported") {
      invalid(url, "此 URL 尚不支持，无法创建 tenant 偏好。");
      return;
    }
    const value = alias.value.trim();
    const preference = preferenceSchema.safeParse({
      ...(value ? { alias: value } : {}),
      environment: environment.value,
    });
    if (!preference.success) {
      const input = preference.error.issues.some(
        (issue) => issue.path[0] === "alias",
      )
        ? alias
        : environment;
      invalid(input, "别名或环境标注无效，请检查后重试。");
      return;
    }
    const previousKey = editKey;
    const paused = excluded.checked;
    setPending(true);
    run(async () => {
      let saved = false;
      try {
        await request({
          type: "tenant-settings",
          key: parsed.tenantKey,
          excluded: paused,
          preference: preference.data,
        });
        saved = true;
        reset();
        setFeedback("Tenant 偏好已保存。", "success", feedback);
        await onChange();
      } finally {
        setPending(false);
        if (saved) focusEdit(previousKey);
      }
    }, feedback);
  });

  return {
    render(status: Status) {
      updateEditingState();
      const keys = new Set<TenantKey>([
        ...(Object.keys(
          status.settings?.tenantPreferences ?? {},
        ) as TenantKey[]),
        ...(status.settings?.excludedTenants ?? []),
        ...(status.runtime?.bindings.map((binding) => binding.tenantKey) ?? []),
      ]);
      const tenants = [...keys].map((key) => ({
        key,
        alias: status.settings?.tenantPreferences[key]?.alias,
        environment:
          status.settings?.tenantPreferences[key]?.environment ?? "unknown",
        paused: status.settings?.excludedTenants.includes(key) ?? false,
      }));
      if (editKey && !pending && !keys.has(editKey)) {
        const formFocused = form.contains(document.activeElement);
        reset();
        if (formFocused) url.focus();
      }
      renderStable(
        container,
        tenants,
        () => {
          container.replaceChildren();
          for (const tenant of tenants) {
            const { key, paused } = tenant;
            const item = el("div", undefined, "item");
            const heading = el("div", undefined, "item-heading");
            heading.append(el("strong", tenant.alias ?? key.split(":")[3]));
            item.append(
              heading,
              el("div", key, "identity"),
              el(
                "p",
                t("{p0} · {p1}", {
                  p0: tenant.environment,
                  p1: t(paused ? "已暂停" : "自动管理"),
                }),
                "muted",
              ),
            );
            const actions = el("div", undefined, "item-actions");
            const edit = el("button", t("编辑"), "secondary");
            edit.type = "button";
            edit.dataset.focusKey = `tenant-edit:${key}`;
            edit.setAttribute(
              "aria-label",
              t("编辑 {p0} 的偏好", {
                p0: tenant.alias ?? key.split(":")[3] ?? key,
              }),
            );
            edit.disabled = pending;
            edit.addEventListener("click", () => {
              if (pending) return;
              editKey = key;
              const [, , partition, label] = key.split(":");
              url.value = `https://${label}${partition === "unpartitioned" ? "" : "." + partition}.my.salesforce.com`;
              alias.value = tenant.alias ?? "";
              environment.value = tenant.environment;
              excluded.checked = paused;
              clearInvalid();
              clearFeedback(feedback);
              updateEditingState();
              url.focus();
            });
            actions.append(edit);
            item.append(actions);
            container.append(item);
          }
          if (!container.childElementCount)
            container.append(
              el("p", t("暂无组织偏好，可在上方添加。"), "empty-state"),
            );
        },
        url,
      );
    },
  };
}
