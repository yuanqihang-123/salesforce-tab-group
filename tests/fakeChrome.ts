import type { BrowserAdapter } from "../src/shared/chrome/browserAdapter";
import type { StorageArea } from "../src/shared/storage/repository";
import type { Snapshot, Tab, Group } from "../src/shared/chrome/types";
export class MemoryStorage implements StorageArea {
  data: Record<string, unknown> = {};
  writes = 0;
  constructor(
    private boundary: (name: string) => void = () => {},
    private area = "local",
  ) {}
  async get(keys: string[]) {
    this.boundary(this.area + ".get.before");
    const result = structuredClone(
      Object.fromEntries(
        keys.filter((k) => k in this.data).map((k) => [k, this.data[k]]),
      ),
    );
    this.boundary(this.area + ".get.after");
    return result;
  }
  async set(items: Record<string, unknown>) {
    this.boundary(this.area + ".set.before");
    Object.assign(this.data, structuredClone(items));
    this.writes++;
    this.boundary(this.area + ".set.after");
  }
}
export function tab(
  id: number,
  url: string | undefined,
  windowId = 1,
  props: Partial<Tab> = {},
): Tab {
  return {
    id,
    index: id - 1,
    windowId,
    groupId: -1,
    pinned: false,
    active: id === 1,
    highlighted: id === 1,
    incognito: false,
    selected: id === 1,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    status: "complete",
    url,
    ...props,
  };
}
export function group(
  id: number,
  windowId = 1,
  title = "User group",
  props: Partial<Group> = {},
): Group {
  return {
    id,
    windowId,
    title,
    color: "blue",
    collapsed: false,
    shared: false,
    ...props,
  };
}
export class FakeChrome implements BrowserAdapter {
  tabs: Tab[] = [];
  groups: Group[] = [];
  windows: chrome.windows.Window[] = [
    {
      id: 1,
      type: "normal",
      incognito: false,
      focused: true,
      alwaysOnTop: false,
      state: "normal",
    },
  ];
  writes: { kind: string; ids: number[]; groupId?: number }[] = [];
  nextGroupId = 100;
  onEcho: (windowId: number) => void = () => {};
  boundary: (name: string) => void = () => {};
  async snapshot(): Promise<Snapshot> {
    this.boundary("snapshot.before");
    const s = structuredClone({
      tabs: this.tabs,
      groups: this.groups,
      windows: this.windows,
    });
    this.boundary("snapshot.after");
    return s;
  }
  async tab(id: number) {
    this.boundary("tab.before");
    const t = this.tabs.find((t) => t.id === id);
    if (!t) throw new Error("No tab with id");
    const result = structuredClone(t);
    this.boundary("tab.after");
    return result;
  }
  async group(id: number) {
    this.boundary("group.before");
    const g = this.groups.find((g) => g.id === id);
    if (!g) throw new Error("No group with id");
    const result = structuredClone(g);
    this.boundary("group.after");
    return result;
  }
  async create(ids: number[], windowId: number) {
    this.boundary("create.before");
    if (
      ids.some(
        (id) => this.tabs.find((t) => t.id === id)?.windowId !== windowId,
      )
    )
      throw new Error("Cannot cross windows");
    const id = this.nextGroupId++;
    this.groups.push(group(id, windowId, ""));
    this.apply(ids, id);
    this.writes.push({ kind: "create", ids, groupId: id });
    this.onEcho(windowId);
    this.boundary("create.after");
    return id;
  }
  async join(ids: number[], groupId: number) {
    this.boundary("join.before");
    const target = await this.group(groupId);
    if (
      ids.some(
        (id) =>
          this.tabs.find((t) => t.id === id)?.windowId !== target.windowId,
      )
    )
      throw new Error("Cannot cross windows");
    this.apply(ids, groupId);
    this.writes.push({ kind: "join", ids, groupId });
    this.onEcho(target.windowId);
    this.boundary("join.after");
    return groupId;
  }
  async ungroup(ids: number[]) {
    this.boundary("ungroup.before");
    const windows = new Set(
      this.tabs.filter((t) => ids.includes(t.id!)).map((t) => t.windowId),
    );
    this.apply(ids, -1);
    this.writes.push({ kind: "ungroup", ids });
    for (const w of windows) this.onEcho(w);
    this.boundary("ungroup.after");
  }
  async metadata(
    groupId: number,
    properties: chrome.tabGroups.UpdateProperties,
  ) {
    this.boundary("metadata.before");
    const target = this.groups.find((g) => g.id === groupId);
    if (!target) throw new Error("No group with id");
    Object.assign(target, properties);
    this.writes.push({ kind: "metadata", ids: [], groupId });
    this.onEcho(target.windowId);
    this.boundary("metadata.after");
    return structuredClone(target);
  }
  private apply(ids: number[], groupId: number) {
    for (const t of this.tabs) if (ids.includes(t.id!)) t.groupId = groupId;
    // Native grouping makes members contiguous. Empty groups disappear.
    if (groupId !== -1) {
      const members = this.tabs.filter((t) => t.groupId === groupId);
      const rest = this.tabs.filter((t) => t.groupId !== groupId);
      const index = Math.min(...members.map((t) => t.index));
      rest.splice(Math.min(index, rest.length), 0, ...members);
      this.tabs = rest;
    }
    for (const w of this.windows)
      this.tabs
        .filter((t) => t.windowId === w.id)
        .forEach((t, i) => (t.index = i));
    this.groups = this.groups.filter((g) =>
      this.tabs.some((t) => t.groupId === g.id),
    );
  }
  userUngroup(id: number) {
    this.apply([id], -1);
  }
  userJoin(id: number, groupId: number) {
    this.apply([id], groupId);
  }
  addWindow(id: number) {
    this.windows.push({
      id,
      type: "normal",
      incognito: false,
      focused: false,
      alwaysOnTop: false,
      state: "normal",
    });
  }
}
