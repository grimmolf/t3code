// Code Mode demo against a local T3 dev server. Usage:
//   node demo.mjs settings <pairUrl> <outDir>
//   node demo.mjs threads <pairUrl> <outDir> <threadPath...>
//   node demo.mjs supervised <pairUrl> <outDir> <threadPath>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(
  "<t3code checkout>/node_modules/.pnpm/playwright@1.64.1/node_modules/playwright",
);

const [phase, pairUrl, outDir, ...rest] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const origin = new URL(pairUrl).origin;
const viewport = { width: 1280, height: 800 };

// The cached Chromium build, since this Playwright release expects a newer one.
const browser = await chromium.launch({
  executablePath: path.join(
    process.env.HOME,
    "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
});
const context = await browser.newContext({ viewport });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
await page.goto(pairUrl);
await page.waitForURL((url) => !url.pathname.startsWith("/pair"));

const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`saved ${name}.png`);
};

const codeModeSwitch = async () => {
  const label = page.getByText("Code Mode (experimental)", { exact: true });
  await label.scrollIntoViewIfNeeded();
  return page
    .locator("div", { has: label })
    .filter({ has: page.getByRole("switch") })
    .last()
    .getByRole("switch")
    .first();
};

const closeDetailsPanel = async () => {
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  if ((await toggle.count()) && (await toggle.getAttribute("aria-pressed")) === "true") {
    await toggle.click();
  }
};


const turnFinished = () =>
  page.waitForFunction(
    () =>
      ![...document.querySelectorAll("div,span,p,button")].some((element) => {
        const text = (element.innerText ?? "").trim();
        return text.length < 30 && /^Working for \d/.test(text);
      }),
    undefined,
    { timeout: 120_000 },
  );

const expandWork = async () => {
  for (const label of await page.getByText(/^Worked for /).all()) await label.click();
  for (const label of await page.getByText("Used T3 Code integration").all()) await label.click();
};

if (phase === "settings") {
  await page.goto(`${origin}/settings/threads`);
  const toggle = await codeModeSwitch();
  if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
  await shot("01-settings-code-mode-off");
  await toggle.click();
  await page.waitForFunction(
    (element) => element.getAttribute("aria-checked") === "true",
    await toggle.elementHandle(),
  );
  console.log(`switch now ${await toggle.getAttribute("aria-checked")}`);
  await shot("02-settings-code-mode-on");
}

if (phase === "threads") {
  for (const [index, threadPath] of rest.entries()) {
    await page.goto(`${origin}${threadPath}`);
    await page.getByText(/^Worked for /).first().waitFor();
    await closeDetailsPanel();
    await expandWork();
    await page.mouse.move(760, 400);
    for (let step = 0; step < 15; step++) await page.mouse.wheel(0, -2000);
    await shot(`0${index + 3}-thread-${index + 1}-top`);
    for (let step = 0; step < 15; step++) await page.mouse.wheel(0, 2000);
    await shot(`0${index + 3}-thread-${index + 1}-bottom`);
  }
}

if (phase === "supervised") {
  const [threadPath] = rest;
  await page.goto(`${origin}${threadPath}`);
  await page.getByText(/^Worked for /).first().waitFor();
  await closeDetailsPanel();
  for (let step = 0; step < 15; step++) await page.mouse.wheel(0, 2000);

  // Frames every 400 ms, stitched into a video with the system ffmpeg afterwards.
  const framesDir = path.join(outDir, "frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir);
  let recording = true;
  let frame = 0;
  const recorder = (async () => {
    while (recording) {
      await page
        .screenshot({ path: path.join(framesDir, `${String(frame++).padStart(4, "0")}.png`) })
        .catch(() => frame--);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  })();
  globalThis.stopRecording = async () => {
    recording = false;
    await recorder;
    console.log(`recorded ${frame} frames`);
  };

  await page.getByRole("button", { name: /Haiku 5\.5/ }).first().click();
  await page.getByText("Full access", { exact: true }).last().click();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();
  await page.keyboard.press("Escape");

  const send = async (text) => {
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.click();
    await composer.fill(text);
    await page.keyboard.press("Enter");
  };

  await send(
    "Use the t3_code_run tool once with title `Index src files`: read every file under src/ with fs, store an array of {path, text} on globalThis.files, and return only the count. Report the count.",
  );
  await page.getByText("Waiting for approval").waitFor();
  await shot("05-supervised-approval-card");
  await page.getByRole("button", { name: "More" }).last().click();
  await page.getByRole("menuitem", { name: "Allow for this thread" }).click();
  await page.getByText("Index src files").last().waitFor();
  await turnFinished();
  await shot("06-allowed-for-thread");
  await turnFinished();

  await send(
    "Call t3_code_run once with title `Count saved files` and code `return { saved: globalThis.files?.length ?? 0 };`. Report the number.",
  );
  await page.getByText("Count saved files").last().waitFor();
  await turnFinished();
  await page.waitForTimeout(1500);
  await shot("07-second-script-no-prompt");
  const cards = await page.getByText("Waiting for approval").count();
  console.log(`pending approval cards after second script: ${cards}`);
  await page.waitForTimeout(2000);
  await globalThis.stopRecording();
}

await context.close();
await browser.close();
