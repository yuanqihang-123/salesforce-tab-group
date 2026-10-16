import { getLanguage, translateMessage } from "./i18n";
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const feedbackMessages = new WeakMap<HTMLElement, string>();

export function translateFeedback() {
  for (const target of Array.from(
    document.querySelectorAll<HTMLElement>(".feedback"),
  )) {
    const message = feedbackMessages.get(target);
    if (message) target.textContent = translateMessage(message);
  }
}

function feedbackTarget() {
  return document.querySelector<HTMLElement>("#feedback");
}

export function clearFeedback(target = feedbackTarget()) {
  if (!target) return;
  feedbackMessages.delete(target);
  target.textContent = "";
  target.classList.remove("visible");
  delete target.dataset.kind;
}

export function setFeedback(
  message: string,
  kind: "success" | "error" = "success",
  target = feedbackTarget(),
) {
  if (target) {
    target.setAttribute("role", kind === "error" ? "alert" : "status");
    target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    target.dataset.kind = kind;
    feedbackMessages.set(target, message);
    target.textContent = translateMessage(message);
    target.classList.add("visible");
  }
}

export function report(error: unknown, target = feedbackTarget()) {
  setFeedback(
    error instanceof Error ? error.message : String(error),
    "error",
    target,
  );
}

export function run(task: () => Promise<unknown>, feedback = feedbackTarget()) {
  void task().catch((error: unknown) => report(error, feedback));
}

const renderedValues = new WeakMap<HTMLElement, string>();

/** Keep unchanged regions intact and preserve keyboard focus when a list changes. */
export function renderStable(
  container: HTMLElement,
  value: unknown,
  render: () => void,
  fallback?: HTMLElement,
) {
  const signature = JSON.stringify([getLanguage(), value]);
  if (renderedValues.get(container) === signature) return;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && container.contains(active);
  const focusKey = focused ? active.dataset.focusKey : undefined;
  const previous = Array.from(
    container.querySelectorAll<HTMLElement>("[data-focus-key]"),
  );
  const index = focused ? previous.indexOf(active) : -1;
  render();
  renderedValues.set(container, signature);
  if (!focused) return;
  const next = Array.from(
    container.querySelectorAll<HTMLElement>("[data-focus-key]"),
  );
  const match = focusKey
    ? next.find((element) => element.dataset.focusKey === focusKey)
    : undefined;
  (
    match ??
    next[Math.min(Math.max(index, 0), next.length - 1)] ??
    fallback
  )?.focus({
    preventScroll: true,
  });
}
