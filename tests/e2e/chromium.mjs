/* global console, process, setTimeout, chrome, document, Event */
import { chromium } from "playwright";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const extension = resolve("dist");
const profile = await mkdtemp(join(tmpdir(), "sfn-chromium-"));
const artifacts = resolve("test-results");
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
  viewport: { width: 1120, height: 900 },
});
const failures = [];
context.on("weberror", (e) => {
  if (e.page()?.url().startsWith("chrome-extension://"))
    failures.push(e.error().message);
});
await context.setOffline(true);
await context.route(/^https?:\/\//, (route) =>
  route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><head><title>SFN test fixture</title></head><body>Offline Salesforce domain fixture</body></html>",
  }),
);
let worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;
async function waitFor(check, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timeout: " + label);
}
const evaluate = (fn) => worker.evaluate(fn);
const results = [];
try {
  await waitFor(
    () =>
      evaluate(
        async () => !!(await chrome.storage.local.get("settings")).settings,
      ),
    "bootstrap",
  );
  assert.equal(
    await evaluate(
      async () =>
        (await chrome.storage.local.get("settings")).settings
          .autoGroupingEnabled,
    ),
    true,
  );
  await evaluate(() => {
    globalThis.__sfnWrites = {
      group: 0,
      ungroup: 0,
      metadata: 0,
      session: 0,
      local: 0,
    };
    for (const [area, name, key] of [
      [chrome.tabs, "group", "group"],
      [chrome.tabs, "ungroup", "ungroup"],
      [chrome.tabGroups, "update", "metadata"],
      [chrome.storage.session, "set", "session"],
      [chrome.storage.local, "set", "local"],
    ]) {
      const original = area[name].bind(area);
      area[name] = (...args) => {
        globalThis.__sfnWrites[key]++;
        return original(...args);
      };
    }
  });
  const start = Date.now();
  await evaluate(async () => {
    for (let w = 0; w < 3; w++) {
      const urls = Array.from(
        { length: 20 },
        (_, i) => `https://org${i % 3}.my.salesforce.com/lightning/page/home`,
      );
      urls.push(
        ...Array.from(
          { length: w === 2 ? 6 : 7 },
          () => `https://example.com/`,
        ),
      );
      await chrome.windows.create({
        url: urls,
        focused: false,
        type: "normal",
      });
    }
  });
  await waitFor(
    () =>
      evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const sf = tabs.filter((t) =>
          /^https:\/\/org[0-2]\.my\.salesforce\.com\//.test(t.url ?? ""),
        );
        return sf.length === 60 && sf.every((t) => t.groupId !== -1);
      }),
    "60 tabs across 3 windows",
  );
  await waitFor(
    () =>
      evaluate(async () =>
        (await chrome.tabGroups.query({})).every((g) =>
          /^org[0-2]$/.test(g.title ?? ""),
        ),
      ),
    "plain tenant titles without ownership markers",
  );
  const initialMs = Date.now() - start;
  assert.equal(
    await evaluate(async () => (await chrome.tabGroups.query({})).length),
    9,
  );
  assert.equal(
    await evaluate(async () =>
      (await chrome.tabs.query({}))
        .filter((t) => t.url === "https://example.com/")
        .every((t) => t.groupId === -1),
    ),
    true,
  );
  results.push({
    test: "3 windows / 60 Salesforce tabs / 20 other tabs, without opening popup",
    passed: true,
    elapsedMs: initialMs,
    apiWrites: await evaluate(() => ({ ...globalThis.__sfnWrites })),
  });
  // A direct Chrome API operation supplies realistic native event echoes.
  const selected = await evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) =>
      t.url?.startsWith("https://org0.my.salesforce.com/"),
    );
    await chrome.tabs.ungroup(t.id);
    return t.id;
  });
  await waitFor(
    () =>
      evaluate(
        async () =>
          Object.keys(
            (await chrome.storage.session.get("runtime")).runtime.overrides,
          ).length === 1,
      ),
    "manual override",
  );
  await evaluate(async () => {
    await chrome.alarms.create("sfn-reconcile", { when: Date.now() + 100 });
  });
  assert.equal(
    await worker.evaluate(
      async (id) => (await chrome.tabs.get(id)).groupId,
      selected,
    ),
    -1,
  );
  results.push({
    test: "Native manual ungroup creates a session override",
    passed: true,
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.getByText("自动分组已开启", { exact: true }).waitFor();
  await options.screenshot({
    path: join(artifacts, "options.png"),
    fullPage: true,
  });
  await options
    .getByRole("button", { name: /^恢复标签页 .* 的自动管理$/ })
    .click();
  await waitFor(
    () =>
      worker.evaluate(
        async (id) => (await chrome.tabs.get(id)).groupId !== -1,
        selected,
      ),
    "restore management",
  );
  await options.getByLabel("启用自动分组", { exact: true }).uncheck();
  await waitFor(
    () =>
      evaluate(
        async () =>
          (await chrome.storage.local.get("settings")).settings
            .autoGroupingEnabled === false,
      ),
    "disable",
  );
  assert.equal(
    await evaluate(async () => !!(await chrome.alarms.get("sfn-reconcile"))),
    false,
  );
  const newTab = await evaluate(async () =>
    chrome.tabs.create({
      url: "https://neworg.my.salesforce.com/",
      active: false,
    }),
  );
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    await worker.evaluate(
      async (id) => (await chrome.tabs.get(id)).groupId,
      newTab.id,
    ),
    -1,
  );
  await options.getByLabel("启用自动分组", { exact: true }).check();
  await waitFor(
    () =>
      worker.evaluate(
        async (id) => (await chrome.tabs.get(id)).groupId !== -1,
        newTab.id,
      ),
    "enable rescan",
  );
  results.push({
    test: "Options: restore override, toggle off/on, alarm removal and rescan",
    passed: true,
  });
  await waitFor(
    () =>
      evaluate(
        async () =>
          !(await chrome.storage.session.get("runtime")).runtime.dirty.length,
      ),
    "stable dirty queue",
  );
  const stableBefore = await evaluate(() => ({ ...globalThis.__sfnWrites }));
  await new Promise((r) => setTimeout(r, 700));
  const stableAfter = await evaluate(() => ({ ...globalThis.__sfnWrites }));
  assert.deepEqual(stableAfter, stableBefore);
  results.push({
    test: "Stable state stops all Chrome and storage writes",
    passed: true,
  });
  const latencies = [];
  for (let i = 0; i < 10; i++) {
    const started = Date.now();
    const t = await evaluate(async () =>
      chrome.tabs.create({
        url: "https://single.my.salesforce.com/lightning/page/home",
        active: false,
      }),
    );
    await waitFor(
      () =>
        worker.evaluate(
          async (id) => (await chrome.tabs.get(id)).groupId !== -1,
          t.id,
        ),
      "incremental tab",
    );
    latencies.push(Date.now() - started);
  }
  latencies.sort((a, b) => a - b);
  results.push({
    test: "10 incremental tab samples",
    passed: true,
    elapsedMs: latencies,
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
    timing: "Includes creation/commit; polling resolution 100ms",
  });
  // Configure and validate the active switching UI without navigating real orgs.
  await options.locator("#target-label").fill("Synthetic UAT");
  await options.locator("#lightning").fill("https://org1.lightning.force.com");
  await options
    .getByRole("button", { name: "保存切换目标", exact: true })
    .click();
  await options.getByText("Synthetic UAT", { exact: true }).waitFor();
  await options.locator("#tenant-url").fill("https://org1.lightning.force.com");
  await options.locator("#environment").selectOption("production");
  await options.getByRole("button", { name: "保存偏好", exact: true }).click();
  await waitFor(
    () =>
      evaluate(
        async () =>
          (await chrome.storage.local.get("settings")).settings
            .tenantPreferences["sf:commercial:unpartitioned:org1"]
            ?.environment === "production",
      ),
    "atomic tenant preference",
  );
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.getByText("自动分组已开启", { exact: true }).waitFor();
  await popup.setViewportSize({ width: 380, height: 800 });
  await popup.screenshot({
    path: join(artifacts, "popup.png"),
    fullPage: true,
  });
  results.push({
    test: "Popup/options render under MV3 CSP; saved target available",
    passed: true,
  });
  // Exercise a popup rendered as a test page while the actual fixture tab is active.
  await popup.locator("#home").check();
  await worker.evaluate(
    async (id) => chrome.tabs.update(id, { active: true }),
    newTab.id,
  );
  await popup.evaluate(() => document.querySelector("#preview").click());
  await popup
    .getByText("Synthetic UAT · production", { exact: true })
    .waitFor();
  assert.equal(
    await popup
      .getByRole("button", { name: "确认并切换当前标签页", exact: true })
      .isDisabled(),
    true,
  );
  await popup.evaluate(() => {
    const checkbox = document.querySelector(".preview input");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector(".preview button").click();
  });
  await waitFor(
    () =>
      worker.evaluate(
        async (id) =>
          (await chrome.tabs.get(id)).url ===
          "https://org1.lightning.force.com/",
        newTab.id,
      ),
    "explicit confirmed production switch",
  );
  results.push({
    test: "Actual popup preview and per-click production confirmation navigate the chosen tab",
    passed: true,
  });
  // Stop the actual worker; the next extension message must restore its session.
  const detached = await worker.evaluate(async () => {
    const t = (await chrome.tabs.query({})).find((t) =>
      t.url?.startsWith("https://single.my.salesforce.com/"),
    );
    await chrome.tabs.ungroup(t.id);
    return t.id;
  });
  await waitFor(
    () =>
      worker.evaluate(async (id) => {
        const runtime = (await chrome.storage.session.get("runtime")).runtime;
        return (
          !!runtime.overrides[id] &&
          runtime.dirty.length === 0 &&
          runtime.intents.length === 0
        );
      }, detached),
    "settled override before worker stop",
  );
  const cdp = await context.newCDPSession(options);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await options.reload();
  await options.getByText("自动分组已开启", { exact: true }).waitFor();
  await waitFor(async () => {
    const workers = context.serviceWorkers();
    const current = workers.find((w) => w.url().includes(extensionId));
    if (current) {
      worker = current;
      return true;
    }
    return false;
  }, "worker restart");
  assert.equal(
    await worker.evaluate(
      async (id) => (await chrome.tabs.get(id)).groupId,
      detached,
    ),
    -1,
  );
  assert.equal(
    await worker.evaluate(
      async (id) =>
        !!(await chrome.storage.session.get("runtime")).runtime.overrides[id],
      detached,
    ),
    true,
  );
  results.push({
    test: "Actual service worker stop/restart preserves manual override",
    passed: true,
  });
  assert.deepEqual(failures, []);
  const report = {
    browser: context.browser()?.version(),
    platform: process.platform,
    headless: true,
    network:
      "Offline context + blocked DNS; HTTP(S) fixtures intercepted, no Salesforce connection",
    results,
    errors: failures,
  };
  await writeFile(
    join(artifacts, "chromium.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const page of context.pages()) {
    if (!page.url().startsWith(`chrome-extension://${extensionId}/`)) continue;
    console.error("Extension page at failure", {
      url: page.url(),
      status: await page.locator("#status").innerText().catch(String),
      feedback: await page.locator("#feedback").innerText().catch(String),
    });
  }
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
