import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/background/coordinator";
import { createMessageHandlers } from "../src/background/messageHandlers";
import { registerMessageRouter } from "../src/background/messageRouter";
import { Switcher } from "../src/features/org-switcher/switcher";
import type { MessageHandlers } from "../src/shared/messaging/contracts";
import { settingsSchema } from "../src/shared/models/settings";
import { Repository } from "../src/shared/storage/repository";
import { FakeChrome, MemoryStorage, tab } from "./fakeChrome";

const extensionId = "sf-org-navigator";
const getURL = (path: string) => `chrome-extension://${extensionId}/${path}`;
const popup = { id: extensionId, url: getURL("popup/index.html") };
const options = { id: extensionId, url: getURL("options/index.html") };
const acme = "sf:commercial:unpartitioned:acme";
const other = "sf:commercial:unpartitioned:other";
type MessageListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];

function connect(handlers: MessageHandlers) {
  let receive!: MessageListener;
  registerMessageRouter(handlers, {
    id: extensionId,
    getURL,
    onMessage: {
      addListener: (listener) => {
        receive = listener;
      },
    },
  });
  return {
    receive,
    request(raw: unknown, sender: chrome.runtime.MessageSender = popup) {
      let respond!: (response: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        respond = resolve;
      });
      const pending = receive(raw, sender, respond);
      return { pending, response };
    },
  };
}

async function setup(count = 0) {
  const browser = new FakeChrome();
  browser.tabs = Array.from({ length: count }, (_, i) =>
    tab(i + 1, "https://acme.my.salesforce.com"),
  );
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const repo = new Repository(local, session);
  const coordinator = new Coordinator(browser, repo);
  browser.onEcho = (windowId) => coordinator.mark(windowId);
  const switcher = new Switcher(repo, {
    get: (id) => browser.tab(id),
    update: async () => undefined,
  });
  const handlers = createMessageHandlers(coordinator, repo, switcher);
  const router = connect(handlers);
  await coordinator.bootstrapPromise;
  await coordinator.flush();
  return { browser, local, session, repo, coordinator, handlers, router };
}

afterEach(() => vi.restoreAllMocks());

describe("background message security boundary", () => {
  it("accepts only the extension's exact popup and options URLs", async () => {
    const { handlers, router } = await setup();
    const toggle = vi.spyOn(handlers, "toggle");
    const senders: chrome.runtime.MessageSender[] = [
      { ...popup, id: "another-extension" },
      { id: extensionId },
      { ...popup, url: "https://acme.my.salesforce.com" },
      { ...popup, url: getURL("other.html") },
      { ...popup, url: popup.url + "?source=page" },
    ];
    for (const sender of senders) {
      const respond = vi.fn();
      expect(
        router.receive({ type: "toggle", enabled: false }, sender, respond),
      ).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    }
    expect(toggle).not.toHaveBeenCalled();
    for (const sender of [popup, options]) {
      const request = router.request({ type: "status" }, sender);
      expect(request.pending).toBe(true);
      expect(await request.response).toMatchObject({ ok: true });
    }
  });

  it("rejects malformed and extra fields before invoking a command", async () => {
    const { handlers, router } = await setup();
    const toggle = vi.spyOn(handlers, "toggle");
    for (const message of [
      { type: "toggle", enabled: "false" },
      { type: "toggle", enabled: false, extra: true },
      { type: "restore-tab", tabId: -1 },
      { type: "unknown" },
    ]) {
      const request = router.request(message);
      expect(request.pending).toBe(false);
      expect(await request.response).toEqual({
        ok: false,
        error: "请求格式无效",
      });
    }
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("serialized application commands", () => {
  it("commits combined tenant settings atomically and preserves concurrent commands", async () => {
    const { local, repo, router } = await setup();
    const commit = local.set.bind(local);
    const revisions: ReturnType<typeof settingsSchema.parse>[] = [];
    vi.spyOn(local, "set").mockImplementation(async (items) => {
      if (items.settings) revisions.push(settingsSchema.parse(items.settings));
      await commit(items);
    });
    const tenantSettings = {
      type: "tenant-settings",
      key: acme,
      preference: { alias: "ACME", environment: "production" },
      excluded: true,
    };
    const first = router.request(tenantSettings);
    const second = router.request({
      type: "preference",
      key: other,
      preference: { alias: "Other" },
    });
    expect(await Promise.all([first.response, second.response])).toEqual([
      { ok: true, data: { ok: true } },
      { ok: true, data: { ok: true } },
    ]);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      excludedTenants: [acme],
      tenantPreferences: { [acme]: tenantSettings.preference },
    });
    expect(revisions[1]).toMatchObject({
      revision: 2,
      excludedTenants: [acme],
      tenantPreferences: {
        [acme]: tenantSettings.preference,
        [other]: { alias: "Other" },
      },
    });
    await router.request(tenantSettings).response;
    expect(revisions).toHaveLength(2);
    expect(repo.settings.revision).toBe(2);
  });

  it("preserves saved settings after a failed commit and keeps status readable", async () => {
    const { local, repo, coordinator, router } = await setup();
    const before = structuredClone(repo.settings);
    vi.spyOn(local, "set").mockRejectedValueOnce(new Error("quota exceeded"));
    const result = await router.request({
      type: "tenant-settings",
      key: acme,
      preference: { alias: "ACME" },
      excluded: true,
    }).response;
    expect(result).toMatchObject({ ok: false });
    expect(repo.settings).toEqual(before);
    expect(local.data.settings).toEqual(before);
    expect(coordinator.degraded).toBe("invalid-or-unwritable-storage");
    expect(await router.request({ type: "status" }).response).toMatchObject({
      ok: true,
      data: { settings: before, degraded: "invalid-or-unwritable-storage" },
    });
    expect(
      await router.request({ type: "toggle", enabled: false }).response,
    ).toMatchObject({ ok: false });
    expect(repo.settings).toEqual(before);
  });

  it("restores a tab through the same queue without deadlocking a following toggle", async () => {
    const { browser, repo, session, coordinator, router } = await setup(1);
    browser.userUngroup(1);
    coordinator.mark(1);
    await coordinator.flush();
    expect(repo.runtime.overrides[1]).toBeDefined();
    const restore = router.request({ type: "restore-tab", tabId: 1 });
    const disable = router.request({ type: "toggle", enabled: false });
    expect(await Promise.all([restore.response, disable.response])).toEqual([
      { ok: true, data: { ok: true } },
      { ok: true, data: { ok: true } },
    ]);
    await coordinator.flush();
    expect(repo.runtime.overrides[1]).toBeUndefined();
    expect(session.data.runtime).toMatchObject({ overrides: {} });
    expect(browser.tabs[0]?.groupId).toBe(-1);
    expect(repo.settings.autoGroupingEnabled).toBe(false);
  });

  it("registers messages before bootstrap storage resolves and queues commands behind it", async () => {
    const browser = new FakeChrome();
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = local.get.bind(local);
    vi.spyOn(local, "get").mockImplementation(async (keys) => {
      await ready;
      return read(keys);
    });
    const repo = new Repository(local, session);
    const coordinator = new Coordinator(browser, repo);
    const handlers = createMessageHandlers(
      coordinator,
      repo,
      new Switcher(repo, {
        get: (id) => browser.tab(id),
        update: async () => undefined,
      }),
    );
    const router = connect(handlers);
    const response = router.request({ type: "toggle", enabled: false });
    const followingEvent = coordinator.serial(
      async () => repo.settings.autoGroupingEnabled,
    );
    expect(response.pending).toBe(true);
    expect(local.data.settings).toBeUndefined();
    release();
    expect(await response.response).toEqual({ ok: true, data: { ok: true } });
    expect(await followingEvent).toBe(false);
    await coordinator.flush();
    expect(repo.settings.autoGroupingEnabled).toBe(false);
  });
});
