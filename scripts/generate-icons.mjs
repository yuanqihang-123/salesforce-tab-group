import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { chromium } from "playwright";

const source = await readFile(
  new URL("../public/icons/icon.svg", import.meta.url),
  "utf8",
);
const browser = await chromium.launch({ channel: "chromium" });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${source}`,
    );
    await page.screenshot({
      path: new URL(`../public/icons/icon${size}.png`, import.meta.url)
        .pathname,
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
