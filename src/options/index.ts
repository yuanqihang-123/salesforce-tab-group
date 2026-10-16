import { getLanguage, initializeLanguage, saveLanguage } from "../shared/i18n";
import "../shared/ui.css";
import { request } from "../shared/messaging/client";
import { renderStatus } from "../shared/statusView";
import { clearFeedback, run, translateFeedback } from "../shared/ui";
import { createTenantPreferences } from "./tenantPreferences";
import { createManualOverrides } from "./manualOverrides";
import { createSwitchTargets } from "./switchTargets";

const enabled = document.querySelector<HTMLInputElement>("#enabled")!;
const tenantPreferences = createTenantPreferences(refresh);
const manualOverrides = createManualOverrides(refresh);
const switchTargets = createSwitchTargets(refresh);
let refreshGeneration = 0;
let toggleBusy = false;
let canToggle = false;
let lastEnabled = false;

async function refresh() {
  const generation = ++refreshGeneration;
  const status = await request({ type: "status" });
  if (generation !== refreshGeneration) return;
  renderStatus(document.getElementById("status")!, status);
  lastEnabled = status.settings?.autoGroupingEnabled ?? false;
  canToggle =
    !status.degraded && !status.runtime?.degraded && !!status.settings;
  if (!toggleBusy) enabled.checked = lastEnabled;
  enabled.disabled = toggleBusy || !canToggle;
  tenantPreferences.render(status);
  manualOverrides.render(status.runtime);
  switchTargets.render(status.settings?.switchTargets ?? []);
}

enabled.addEventListener("change", () =>
  run(async () => {
    if (toggleBusy) return;
    toggleBusy = true;
    enabled.disabled = true;
    clearFeedback();
    try {
      await request({ type: "toggle", enabled: enabled.checked });
      await refresh();
    } finally {
      toggleBusy = false;
      enabled.checked = lastEnabled;
      enabled.disabled = !canToggle;
    }
  }),
);

let timer: ReturnType<typeof setTimeout>;
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === "local" && changes.settings) ||
    (area === "session" && changes.runtime)
  ) {
    clearTimeout(timer);
    timer = setTimeout(() => run(refresh), 300);
  }
});

function updateNavigation() {
  for (const link of Array.from(
    document.querySelectorAll<HTMLAnchorElement>(".settings-nav a"),
  )) {
    if (link.hash === (location.hash || "#grouping"))
      link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", updateNavigation);
updateNavigation();
const language = document.querySelector<HTMLSelectElement>("#language")!;
language.addEventListener("change", () =>
  run(async () => {
    language.disabled = true;
    try {
      await saveLanguage(language.value);
    } finally {
      language.value = getLanguage();
      language.disabled = false;
    }
  }),
);
run(async () => {
  await initializeLanguage(() => {
    translateFeedback();
    run(refresh);
  });
  language.disabled = false;
  await refresh();
});
