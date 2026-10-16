/* global console, process, setTimeout, chrome, document, window */
import { chromium } from "playwright";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const extension = resolve("dist");
const artifacts = resolve("test-results");
const profile = await mkdtemp(join(tmpdir(), "sfn-ui-"));
await mkdir(artifacts, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--no-proxy-server",
  ],
  viewport: { width: 1200, height: 900 },
});
const failures = [];
const results = [];
let options;
let popup;
let extensionId;
context.on("weberror", (event) => {
  if (event.page()?.url().startsWith("chrome-extension://"))
    failures.push(event.error().message);
});
await context.setOffline(true);
await context.route(/^https?:\/\//, (route) =>
  route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><head><title>SFN UI fixture</title></head><body>Offline Salesforce UI fixture</body></html>",
  }),
);
const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
extensionId = new URL(worker.url()).host;
const evaluate = (fn, argument) => worker.evaluate(fn, argument);
const settings = () =>
  evaluate(async () => (await chrome.storage.local.get("settings")).settings);

async function waitFor(check, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timeout: " + label);
}

async function focused(locator, label) {
  await waitFor(
    () => locator.evaluate((node) => node === document.activeElement),
    label,
  );
}

async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport + 1 &&
      dimensions.body <= dimensions.viewport + 1,
    `${label}: horizontal overflow ${JSON.stringify(dimensions)}`,
  );
}

// Delay response delivery while preserving the real extension request, worker
// validation, storage events and browser APIs. This makes races deterministic.
async function installMessageHarness(page) {
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__uiHarness = { counts: {}, holdType: null, release: null };
    chrome.runtime.sendMessage = async (...args) => {
      const type = args[0]?.type;
      const harness = window.__uiHarness;
      harness.counts[type] = (harness.counts[type] ?? 0) + 1;
      const hold = harness.holdType === type;
      if (hold) harness.holdType = null;
      const response = await original(...args);
      if (!hold) return response;
      return new Promise((resolve) => {
        harness.release = () => {
          harness.release = null;
          resolve(response);
        };
      });
    };
  });
}

async function holdResponse(page, type) {
  await page.evaluate((type) => {
    window.__uiHarness.holdType = type;
  }, type);
}

async function responseHeld(page) {
  await waitFor(
    () => page.evaluate(() => !!window.__uiHarness.release),
    "response held by UI harness",
  );
}

async function releaseResponse(page) {
  await page.evaluate(() => window.__uiHarness.release());
}

async function runtimePulse() {
  await evaluate(async () => {
    const { runtime } = await chrome.storage.session.get("runtime");
    await chrome.storage.session.set({
      runtime: { ...runtime, lastScan: runtime.lastScan + 1 },
    });
  });
  // Both UI refresh debounce (300 ms) and background activity must have time to run.
  await new Promise((resolve) => setTimeout(resolve, 650));
}

async function addTarget(label, origin) {
  await options.locator("#target-label").fill(label);
  await options.locator("#lightning").fill(origin);
  await options.locator("#lightning").press("Enter");
  await waitFor(
    async () => (await settings()).switchTargets.some((t) => t.label === label),
    `target saved: ${label}`,
  );
  await waitFor(
    () => options.locator("#cancel-edit").isHidden(),
    "target editor reset",
  );
  await options.locator("#targets").getByText(label, { exact: true }).waitFor();
}

async function activateFixture(tabId) {
  await evaluate(async (id) => chrome.tabs.update(id, { active: true }), tabId);
}

async function previewWithKeyboard(tabId) {
  await activateFixture(tabId);
  await popup.locator("#preview").focus();
  await popup.keyboard.press("Enter");
  await popup
    .getByRole("button", { name: "确认并切换当前标签页", exact: true })
    .waitFor();
}

try {
  await waitFor(async () => !!(await settings()), "extension bootstrap");
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.locator("#enabled:enabled").waitFor();
  assert.equal(
    await popup
      .locator("html")
      .evaluate((node) => node.getBoundingClientRect().width),
    420,
    "Popup document supplies its own width before the browser sizes the window",
  );
  assert.equal(await popup.locator("#preview").isDisabled(), true);
  assert.equal(await popup.locator("#target").inputValue(), "");
  await popup.setViewportSize({ width: 420, height: 600 });
  await noOverflow(popup, "empty popup");
  await popup.screenshot({
    path: join(artifacts, "ui-popup.png"),
    fullPage: true,
  });
  results.push({ test: "Popup empty state prevents preview", passed: true });

  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.locator("#enabled:enabled").waitFor();
  await installMessageHarness(options);
  await options.locator("#target-label").fill("Keyboard UAT");
  await options
    .locator("#lightning")
    .fill("https://keyboard.lightning.force.com");
  await holdResponse(options, "save-target");
  await options.locator("#lightning").press("Enter");
  await responseHeld(options);
  await options.keyboard.press("Enter");
  assert.equal(
    await options.evaluate(() => window.__uiHarness.counts["save-target"]),
    1,
  );
  assert.equal((await settings()).switchTargets.length, 1);
  await releaseResponse(options);
  await waitFor(
    async () =>
      /保存/.test(await options.locator("#target-feedback").innerText()),
    "target save feedback",
  );
  await options
    .locator("#targets")
    .getByText("Keyboard UAT", { exact: true })
    .waitFor();
  results.push({
    test: "Native Enter submits once while save is pending, then announces success",
    passed: true,
  });

  const editTarget = options
    .locator("#targets")
    .getByRole("button", { name: /编辑/ })
    .first();
  await editTarget.focus();
  await options.keyboard.press("Enter");
  await focused(options.locator("#target-label"), "target edit focuses name");
  await options.locator("#target-label").fill("Unsaved draft");
  await runtimePulse();
  assert.equal(
    await options.locator("#target-label").inputValue(),
    "Unsaved draft",
  );
  await focused(
    options.locator("#target-label"),
    "runtime refresh preserves field focus",
  );
  await options.keyboard.press("Escape");
  await focused(editTarget, "Escape restores target edit button focus");
  assert.equal(await options.locator("#target-label").inputValue(), "");
  await runtimePulse();
  await focused(editTarget, "runtime refresh preserves target list focus");
  results.push({
    test: "Edit Escape restores focus; runtime refresh preserves draft and list focus",
    passed: true,
  });

  await options
    .locator("#tenant-url")
    .fill("https://keyboard.lightning.force.com");
  await options.locator("#alias").fill("Keyboard production");
  await options.locator("#environment").selectOption("production");
  await options.locator("#alias").press("Enter");
  await waitFor(
    async () =>
      /保存/.test(await options.locator("#tenant-feedback").innerText()),
    "tenant save feedback",
  );
  const editTenant = options
    .locator("#tenants")
    .getByRole("button", { name: /编辑/ })
    .first();
  await editTenant.focus();
  await options.keyboard.press("Enter");
  await focused(options.locator("#tenant-url"), "tenant edit focuses URL");
  await options.locator("#environment").focus();
  await options.keyboard.press("Space");
  await options.keyboard.press("Escape");
  assert.equal(await options.locator("#cancel-tenant-edit").isVisible(), true);
  await focused(
    options.locator("#environment"),
    "Native select Escape keeps editor open",
  );
  await options.locator("#alias").fill("Unsaved alias");
  await options.keyboard.press("Escape");
  await focused(editTenant, "Escape restores tenant edit button focus");
  await runtimePulse();
  await focused(editTenant, "runtime refresh preserves tenant list focus");
  results.push({
    test: "Tenant keyboard save, feedback and Escape focus return",
    passed: true,
  });

  await editTarget.focus();
  await options.keyboard.press("Enter");
  const firstTarget = (await settings()).switchTargets[0];
  await options.evaluate(async (id) => {
    const response = await chrome.runtime.sendMessage({
      type: "remove-target",
      id,
    });
    if (!response.ok) throw new Error(response.error);
  }, firstTarget.id);
  await waitFor(
    () => options.locator("#cancel-edit").isHidden(),
    "removing edited target resets editor",
  );
  assert.equal(await options.locator("#target-label").inputValue(), "");
  results.push({
    test: "Deleting the edited target from another session resets the stale editor",
    passed: true,
  });

  await addTarget(
    "Keyboard production",
    "https://keyboard.lightning.force.com",
  );
  const longLabel = "LongOrgLabel".repeat(7).slice(0, 80);
  await addTarget(longLabel, "https://other.lightning.force.com");
  const savedTargets = (await settings()).switchTargets;
  const productionTarget = savedTargets.find(
    (t) => t.label === "Keyboard production",
  );
  const otherTarget = savedTargets.find((t) => t.label === longLabel);
  await options.setViewportSize({ width: 1200, height: 900 });
  await noOverflow(options, "desktop settings with long target label");
  await options.evaluate(() => window.scrollTo(0, 0));
  await options.screenshot({
    path: join(artifacts, "ui-options.png"),
    fullPage: true,
  });
  await options.setViewportSize({ width: 360, height: 800 });
  await options.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await noOverflow(options, "narrow dark settings with long target label");
  await options.evaluate(() => window.scrollTo(0, 0));
  await options.screenshot({
    path: join(artifacts, "ui-options-mobile.png"),
    fullPage: true,
  });
  results.push({
    test: "Desktop and 360 px dark settings have no horizontal overflow",
    passed: true,
  });

  await popup.reload();
  await waitFor(
    () =>
      popup
        .locator("#target option")
        .count()
        .then((count) => count === 2),
    "popup loads configured targets",
  );
  await installMessageHarness(popup);
  await popup.locator("#target").selectOption(otherTarget.id);
  await popup.locator("#enabled").focus();
  await popup.keyboard.press("Space");
  await waitFor(
    async () => !(await settings()).autoGroupingEnabled,
    "disable grouping",
  );
  await popup.locator("#enabled:enabled").waitFor();
  assert.equal(await popup.locator("#target").inputValue(), otherTarget.id);
  await popup.locator("#enabled").focus();
  await popup.keyboard.press("Space");
  await waitFor(
    async () => (await settings()).autoGroupingEnabled,
    "enable grouping",
  );
  await popup.locator("#enabled:enabled").waitFor();
  assert.equal(await popup.locator("#target").inputValue(), otherTarget.id);
  assert.equal(await popup.locator("#surface").isDisabled(), true);
  await popup.locator("#target").focus();
  await popup.keyboard.press("Tab");
  await focused(popup.locator("#home"), "Tab reaches homepage toggle");
  await popup.keyboard.press("Tab");
  await focused(popup.locator("#preview"), "Tab skips hidden homepage surface");
  await popup.keyboard.press("Shift+Tab");
  await popup.keyboard.press("Space");
  assert.equal(await popup.locator("#surface").isDisabled(), false);
  await popup.keyboard.press("Tab");
  await focused(
    popup.locator("#surface"),
    "Tab reaches visible homepage surface",
  );
  assert.deepEqual(
    await popup
      .locator("#surface option")
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    ["lightning"],
  );
  results.push({
    test: "Space toggles grouping without losing target; homepage surfaces match target",
    passed: true,
  });

  // Language is a separate browser preference, and changing it preserves drafts.
  const settingsBeforeLanguage = await settings();
  await options.locator("#targets button").first().click();
  await options.locator("#target-label").fill("Language draft");
  await options.locator("#language").selectOption("en");
  await waitFor(
    () =>
      popup
        .locator("html")
        .getAttribute("lang")
        .then((value) => value === "en"),
    "language reaches open popup",
  );
  await options
    .getByRole("heading", { name: "Interface language", exact: true })
    .waitFor();
  await options
    .getByRole("heading", { name: "Edit switch target", exact: true })
    .waitFor();
  assert.equal(
    await options.locator("#target-label").inputValue(),
    "Language draft",
  );
  assert.equal(
    await options.locator("#save-target").textContent(),
    "Save changes",
  );
  assert.equal(
    await options.locator("#target-label").getAttribute("placeholder"),
    "e.g. ACME / UAT",
  );
  assert.equal(
    await popup.locator("#settings").getAttribute("aria-label"),
    "Open settings",
  );
  await waitFor(
    () =>
      popup
        .locator("#status")
        .innerText()
        .then((text) => text.includes("managed groups")),
    "dynamic status translated",
  );
  for (const page of [options, popup]) {
    const untranslated = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.body,
        window.NodeFilter.SHOW_TEXT,
      );
      const result = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest("#language, script, style")) continue;
        if (/\p{Script=Han}/u.test(node.textContent))
          result.push(node.textContent.trim());
      }
      return result;
    });
    assert.deepEqual(
      untranslated,
      [],
      "English interface has no untranslated Chinese text",
    );
  }
  assert.deepEqual(await settings(), settingsBeforeLanguage);
  await options.locator("#cancel-edit").click();
  await options.locator("#target-label").fill("Invalid origin");
  await options.locator("#save-target").click();
  await waitFor(
    () =>
      options
        .locator("#target-feedback")
        .innerText()
        .then((text) => text === "Configure at least one origin."),
    "English validation feedback",
  );
  await options.locator("#language").selectOption("zh-CN");
  await waitFor(
    () =>
      options
        .locator("#target-feedback")
        .innerText()
        .then((text) => text === "请至少配置一个 origin。"),
    "existing form error switches back to Chinese",
  );
  await options.locator("#language").selectOption("en");
  await waitFor(
    () =>
      options
        .locator("#target-feedback")
        .innerText()
        .then((text) => text === "Configure at least one origin."),
    "existing form error switches to English",
  );
  await noOverflow(options, "English narrow settings");
  await noOverflow(popup, "English popup");
  await options.screenshot({
    path: join(artifacts, "ui-options-en.png"),
    fullPage: true,
  });
  await popup.screenshot({
    path: join(artifacts, "ui-popup-en.png"),
    fullPage: true,
  });
  await options.reload();
  await options.locator("#language:enabled").waitFor();
  assert.equal(await options.locator("#language").inputValue(), "en");
  assert.equal(await options.locator("html").getAttribute("lang"), "en");
  assert.match(await options.title(), /^Settings/);
  await popup.reload();
  await popup.locator("#enabled:enabled").waitFor();
  assert.equal(await popup.locator("html").getAttribute("lang"), "en");
  await options.locator("#language").selectOption("zh-CN");
  await waitFor(
    () =>
      popup
        .locator("#preview")
        .innerText()
        .then((text) => text.includes("预览切换")),
    "switch back to Chinese",
  );
  await options
    .getByRole("heading", { name: "界面语言", exact: true })
    .waitFor();
  await options
    .getByRole("heading", { name: "添加切换目标", exact: true })
    .waitFor();
  assert.match(await options.title(), /^设置/);
  // Reloading the popup removed its request-delay harness.
  await installMessageHarness(popup);
  await popup.locator("#target").selectOption(otherTarget.id);
  await popup.locator("#home").check();
  results.push({
    test: "Language switches both pages, preserves drafts and settings, translates errors and persists after reload",
    passed: true,
  });

  const fixture = await evaluate(async () =>
    chrome.tabs.create({
      url: "https://source.my.salesforce.com/lightning/page/home",
      active: true,
    }),
  );
  await waitFor(
    () =>
      evaluate(
        async (id) => !(await chrome.tabs.get(id)).pendingUrl,
        fixture.id,
      ),
    "offline source fixture committed",
  );
  const manualFixture = await evaluate(async () =>
    chrome.tabs.create({
      url: "https://manual.my.salesforce.com/",
      active: false,
    }),
  );
  await waitFor(
    () =>
      evaluate(
        async (ids) => {
          const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
          return tabs.every((tab) => tab.groupId !== -1);
        },
        [fixture.id, manualFixture.id],
      ),
    "both fixtures automatically grouped",
  );
  await evaluate(
    async (ids) => {
      for (const id of ids) await chrome.tabs.ungroup(id);
    },
    [fixture.id, manualFixture.id],
  );
  const restoreButtons = options.locator("#overrides button");
  await waitFor(
    () => restoreButtons.count().then((count) => count === 2),
    "native ungroup exposes two manual overrides",
  );
  await restoreButtons.first().focus();
  await options.keyboard.press("Enter");
  await waitFor(
    () => restoreButtons.count().then((count) => count === 1),
    "first keyboard restore completes",
  );
  await focused(
    restoreButtons.first(),
    "restore returns focus to adjacent action",
  );
  await options.keyboard.press("Enter");
  await waitFor(
    () => restoreButtons.count().then((count) => count === 0),
    "last keyboard restore completes",
  );
  await focused(
    options.locator("#manual-overrides"),
    "last restore focuses section",
  );
  results.push({
    test: "Native ungroup and keyboard restore focus the adjacent action, then the empty section",
    passed: true,
  });

  await evaluate(
    async (id) => chrome.tabs.update(id, { pinned: true }),
    fixture.id,
  );
  await waitFor(
    () =>
      options
        .locator("#status dt")
        .allTextContents()
        .then((labels) => labels.includes("已固定")),
    "pinned reason is shown",
  );
  await options.locator("#status summary").focus();
  await evaluate(
    async (id) => chrome.tabs.update(id, { pinned: false }),
    fixture.id,
  );
  await waitFor(
    () =>
      options
        .locator("#status summary")
        .count()
        .then((count) => count === 0),
    "last reason disappears after unpin",
  );
  await focused(
    options.locator("#enabled"),
    "disappearing status details restore focus to grouping toggle",
  );
  results.push({
    test: "Removing the last status reason preserves keyboard focus",
    passed: true,
  });

  await holdResponse(popup, "preview-switch");
  await activateFixture(fixture.id);
  await popup.locator("#preview").focus();
  await popup.keyboard.press("Enter");
  await responseHeld(popup);
  await popup.locator("#target").selectOption(productionTarget.id);
  await releaseResponse(popup);
  await popup.locator("#preview:enabled").waitFor();
  assert.equal(await popup.locator("#switch-preview button").count(), 0);
  results.push({
    test: "Changed target rejects a delayed real preview response",
    passed: true,
  });

  await previewWithKeyboard(fixture.id);
  assert.equal(
    await popup.locator("#production-confirmation").isChecked(),
    false,
  );
  const execute = popup.getByRole("button", {
    name: "确认并切换当前标签页",
    exact: true,
  });
  assert.equal(await execute.isDisabled(), true);
  await popup.keyboard.press("Escape");
  await focused(
    popup.locator("#preview"),
    "Escape restores preview button focus",
  );
  assert.equal(await popup.locator("#switch-preview button").count(), 0);
  results.push({
    test: "Enter previews only; production requires confirmation; Escape cancels and returns focus",
    passed: true,
  });

  await previewWithKeyboard(fixture.id);
  await options.evaluate(async (target) => {
    const response = await chrome.runtime.sendMessage({
      type: "save-target",
      target: { ...target, label: target.label + " updated" },
    });
    if (!response.ok) throw new Error(response.error);
  }, productionTarget);
  await waitFor(
    () =>
      popup
        .locator("#switch-preview button")
        .count()
        .then((count) => count === 0),
    "local settings invalidates preview",
  );
  assert.equal(
    await popup.locator("#target").inputValue(),
    productionTarget.id,
  );
  results.push({
    test: "Settings updates invalidate preview and preserve selected target",
    passed: true,
  });

  await previewWithKeyboard(fixture.id);
  assert.equal(await execute.isDisabled(), true);
  await popup.locator("#production-confirmation").focus();
  await popup.keyboard.press("Space");
  assert.equal(
    await popup.locator("#production-confirmation").isChecked(),
    true,
  );
  await popup.keyboard.press("Tab");
  await focused(execute, "Tab reaches confirmed production execution button");
  await popup.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await popup.setViewportSize({ width: 420, height: 600 });
  await noOverflow(popup, "narrow dark production preview");
  for (const control of [popup.locator("#production-confirmation"), execute]) {
    const box = await control.boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= 600,
      `Production confirmation control is outside the 600 px popup: ${JSON.stringify(box)}`,
    );
  }
  await popup.screenshot({
    path: join(artifacts, "ui-popup-preview.png"),
    fullPage: true,
  });
  await popup.keyboard.press("Enter");
  await waitFor(
    () =>
      evaluate(
        async (id) =>
          (await chrome.tabs.get(id)).url ===
          "https://keyboard.lightning.force.com/",
        fixture.id,
      ),
    "keyboard confirmed production navigation",
  );
  results.push({
    test: "Space, Tab and Enter explicitly confirm production navigation",
    passed: true,
  });
  assert.deepEqual(failures, []);
} catch (error) {
  failures.push(error instanceof Error ? error.stack : String(error));
  for (const page of [options, popup]) {
    if (!page || page.isClosed()) continue;
    console.error("UI page at failure", {
      url: page.url(),
      state: await page
        .evaluate(() => ({
          feedback: document.getElementById("feedback")?.textContent,
          targetFeedback:
            document.getElementById("target-feedback")?.textContent,
          focused: document.activeElement?.outerHTML.slice(0, 1000),
        }))
        .catch(String),
    });
  }
  process.exitCode = 1;
} finally {
  const report = {
    browser: context.browser()?.version(),
    platform: process.platform,
    headless: true,
    network:
      "Offline context, blocked DNS and intercepted HTTP(S); no Salesforce connection",
    scope:
      "Real MV3 worker and extension pages; popup is hosted as a page for deterministic keyboard input. Response-delay harness preserves real worker responses. Native action-popup chrome, OS shortcuts and IME candidate UI require manual acceptance.",
    results,
    errors: failures,
  };
  await writeFile(join(artifacts, "ui.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
