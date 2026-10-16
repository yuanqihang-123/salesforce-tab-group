import { t } from "../shared/i18n";
import { parseTargetInput } from "../features/org-switcher/targetInput";
import { request } from "../shared/messaging/client";
import type { SwitchTarget } from "../shared/models/settings";
import { parseSalesforceUrl } from "../shared/salesforce/urlParser";
import {
  clearFeedback,
  el,
  renderStable,
  run,
  setFeedback,
} from "../shared/ui";

export function createSwitchTargets(onChange: () => Promise<void>) {
  const form = document.getElementById("target-form") as HTMLFormElement;
  const container = document.getElementById("targets")!;
  const label = document.getElementById("target-label") as HTMLInputElement;
  const cancel = document.getElementById("cancel-edit") as HTMLButtonElement;
  const save = document.getElementById("save-target") as HTMLButtonElement;
  const title = document.getElementById("target-form-title")!;
  const feedback = document.getElementById("target-feedback");
  const origins = {
    lightning: document.getElementById("lightning") as HTMLInputElement,
    "my-domain": document.getElementById("my-domain") as HTMLInputElement,
    setup: document.getElementById("setup") as HTMLInputElement,
  };
  const inputs = [label, ...Object.values(origins)];
  let editId: string | undefined;
  let pending = false;
  let composing = false;
  let disabledControls: [HTMLInputElement | HTMLButtonElement, boolean][] = [];

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

  function markInvalid(input: HTMLInputElement) {
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
    title.textContent = editId ? t("编辑切换目标") : t("添加切换目标");
    cancel.hidden = !editId;
    save.textContent = pending
      ? t("处理中…")
      : editId
        ? t("保存修改")
        : t("保存切换目标");
  }

  function reset() {
    editId = undefined;
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
        form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
          "input, button",
        ),
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

  function focusEdit(id: string | undefined) {
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-focus-key]"),
    ).find((node) => node.dataset.focusKey === `target-edit:${id}`);
    (button ?? label).focus();
  }

  function cancelEditing() {
    if (pending || !editId) return;
    const previousId = editId;
    reset();
    focusEdit(previousId);
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
      !composing &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.defaultPrevented &&
      editId &&
      !pending
    ) {
      event.preventDefault();
      cancelEditing();
    }
  });
  for (const input of inputs)
    input.addEventListener("input", () => {
      clearInvalid();
      clearFeedback(feedback);
    });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending || composing) return;
    clearInvalid();
    clearFeedback(feedback);
    let target: SwitchTarget;
    try {
      target = parseTargetInput({
        id: editId ?? crypto.randomUUID(),
        label: label.value,
        origins: Object.fromEntries(
          Object.entries(origins).map(([surface, input]) => [
            surface,
            input.value,
          ]),
        ),
      });
    } catch (error) {
      let invalid = label;
      if (label.value.trim() && label.value.trim().length <= 80) {
        const populated = Object.entries(origins).filter(([, input]) =>
          input.value.trim(),
        );
        const first = parseSalesforceUrl(populated[0]?.[1].value.trim());
        invalid =
          populated.find(([surface, input]) => {
            const value = input.value.trim();
            const parsed = parseSalesforceUrl(value);
            let exact = false;
            try {
              exact = new URL(value).origin === value;
            } catch {
              /* The parser below reports an invalid URL. */
            }
            return (
              !exact ||
              parsed.kind !== "supported" ||
              parsed.surface !== surface ||
              first.kind !== "supported" ||
              parsed.tenantKey !== first.tenantKey
            );
          })?.[1] ?? origins.lightning;
      }
      setFeedback(
        error instanceof Error ? error.message : String(error),
        "error",
        feedback,
      );
      markInvalid(invalid);
      return;
    }
    const previousId = editId;
    setPending(true);
    run(async () => {
      let saved = false;
      try {
        await request({ type: "save-target", target });
        saved = true;
        reset();
        setFeedback("切换目标已保存。", "success", feedback);
        await onChange();
      } finally {
        setPending(false);
        if (saved) focusEdit(previousId);
      }
    }, feedback);
  });

  return {
    render(targets: SwitchTarget[]) {
      updateEditingState();
      if (
        editId &&
        !pending &&
        !targets.some((target) => target.id === editId)
      ) {
        const formFocused = form.contains(document.activeElement);
        reset();
        if (formFocused) label.focus();
      }
      renderStable(
        container,
        targets,
        () => {
          container.replaceChildren();
          for (const target of targets) {
            const item = el("div", undefined, "item");
            const heading = el("div", undefined, "item-heading");
            heading.append(el("strong", target.label));
            item.append(heading, el("div", target.tenantKey, "identity"));
            for (const [surface, origin] of Object.entries(target.origins))
              item.append(el("div", `${surface} · ${origin}`, "identity"));
            const buttons = el("div", undefined, "item-actions");
            const edit = el("button", t("编辑"), "secondary");
            const remove = el("button", t("删除目标"), "secondary");
            edit.type = remove.type = "button";
            edit.dataset.focusKey = `target-edit:${target.id}`;
            remove.dataset.focusKey = `target-remove:${target.id}`;
            edit.setAttribute(
              "aria-label",
              t("编辑 {p0}", { p0: target.label }),
            );
            remove.setAttribute(
              "aria-label",
              t("删除目标 {p0}", { p0: target.label }),
            );
            edit.disabled = remove.disabled = pending;
            edit.addEventListener("click", () => {
              if (pending) return;
              editId = target.id;
              label.value = target.label;
              for (const surface of Object.keys(
                origins,
              ) as (keyof typeof origins)[])
                origins[surface].value = target.origins[surface] ?? "";
              clearInvalid();
              clearFeedback(feedback);
              updateEditingState();
              label.focus();
            });
            remove.addEventListener("click", () => {
              if (pending) return;
              const index = Array.from(
                container.querySelectorAll("button"),
              ).indexOf(remove);
              setPending(true);
              run(async () => {
                let removed = false;
                try {
                  await request({ type: "remove-target", id: target.id });
                  removed = true;
                  if (editId === target.id) reset();
                  setFeedback("切换目标已删除。", "success", feedback);
                  await onChange();
                } finally {
                  setPending(false);
                  if (removed) {
                    const remaining =
                      container.querySelectorAll<HTMLButtonElement>("button");
                    (
                      remaining[Math.min(index, remaining.length - 1)] ?? label
                    ).focus();
                  }
                }
              }, feedback);
            });
            buttons.append(edit, remove);
            item.append(buttons);
            container.append(item);
          }
          if (!container.childElementCount)
            container.append(
              el(
                "p",
                t("尚未配置目标。在 popup 中切换前，先添加一个目标。"),
                "empty-state",
              ),
            );
        },
        label,
      );
    },
  };
}
