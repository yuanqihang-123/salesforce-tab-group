/* global console */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = "dist";
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
assert.equal(manifest.manifest_version, 3);
assert.deepEqual([...manifest.permissions].sort(), [
  "alarms",
  "storage",
  "tabGroups",
  "tabs",
]);
assert.equal(manifest.incognito, "not_allowed");
for (const key of [
  "host_permissions",
  "optional_host_permissions",
  "content_scripts",
  "externally_connectable",
  "web_accessible_resources",
])
  assert.equal(manifest[key], undefined, key);
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.background.type, "module");
for (const file of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
])
  assert.equal((await stat(join(root, file))).isFile(), true, file);
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      ),
    )
  ).flat();
}
const files = await walk(root);
for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(
    source,
    /\beval\s*\(|\bnew\s+Function\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|@vite\/client|import\.meta\.hot/,
    file,
  );
  assert.doesNotMatch(source, /<script[^>]+src=["']https?:/i, file);
}
console.log(
  `Release audit passed: ${files.length} files; minimal permissions, local assets, no injection/network/eval/HMR code.`,
);
