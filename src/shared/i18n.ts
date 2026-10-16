import { english } from "./translations";

export type Language = "zh-CN" | "en";
export const languageStorageKey = "uiLanguage";
let language: Language = "zh-CN";

export function getLanguage(): Language {
  return language;
}

/** Chinese source strings are also the fallback for missing translations. */
export function t(
  source: string,
  values: Record<string, string | number> = {},
) {
  const message = language === "en" ? (english[source] ?? source) : source;
  return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}

/** Translate errors sent by the worker without changing its protocol. */
export function translateMessage(source: string) {
  const restored = /^标签页 (\d+) 已恢复自动管理。$/.exec(source);
  if (restored) return t("标签页 {p0} 已恢复自动管理。", { p0: restored[1]! });
  const origin = /^请先配置 (.+) origin，或选择已配置的目标首页。$/.exec(
    source,
  );
  return origin
    ? t("请先配置 {p0} origin，或选择已配置的目标首页。", { p0: origin[1]! })
    : t(source);
}

export async function saveLanguage(value: string) {
  if (value !== "zh-CN" && value !== "en") throw new Error("Invalid language");
  await chrome.storage.local.set({ [languageStorageKey]: value });
}

/** Capture only the original HTML, never user content or dynamically rendered lists. */
export async function initializeLanguage(onChange: () => void) {
  const textNodes: { node: Text; source: string }[] = [];
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("script, style")) continue;
    const source = node.data.replace(/\s+/g, " ").trim();
    if (Object.hasOwn(english, source)) textNodes.push({ node, source });
  }
  const attributes: { node: Element; name: string; source: string }[] = [];
  for (const node of Array.from(
    document.querySelectorAll("[aria-label], [title], [placeholder]"),
  )) {
    for (const name of ["aria-label", "title", "placeholder"]) {
      const source = node.getAttribute(name);
      if (source && Object.hasOwn(english, source))
        attributes.push({ node, name, source });
    }
  }
  function apply(value: unknown) {
    language = value === "en" ? "en" : "zh-CN";
    document.documentElement.lang = language;
    for (const { node, source } of textNodes) {
      if (node.isConnected) node.data = ` ${t(source)} `;
    }
    for (const { node, name, source } of attributes)
      node.setAttribute(name, t(source));
    const control = document.querySelector<HTMLSelectElement>("#language");
    if (control) control.value = language;
  }
  // Register before the initial read so changes cannot be missed during startup.
  let changed = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[languageStorageKey]) return;
    changed = true;
    apply(changes[languageStorageKey].newValue);
    onChange();
  });
  const stored = await chrome.storage.local.get(languageStorageKey);
  if (!changed) apply(stored[languageStorageKey]);
}
