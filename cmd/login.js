// Interactive login: opens a real browser window, you sign in by hand (so
// captcha / SMS / 2FA are not a problem), then the session is saved to
// auth-state.json and reused by every later scrape.
//
//   node cmd/login.js

const path = require("path");
const readline = require("readline");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { chromium } = require("playwright");
const { STATE_PATH } = require(path.join(__dirname, "..", "scraper", "browser.js"));

const baseURL = process.env.SCRAPPER_BASE_URL;

if (!baseURL) {
  console.error("SCRAPPER_BASE_URL is not set in .env");
  process.exit(1);
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "ru-RU" });
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: "load" });

  console.log(`\nA browser window is open at ${baseURL}`);
  console.log("Log in there, open any lesson to confirm you have access, then come back here.\n");

  await waitForEnter("Press Enter once you are logged in... ");

  await context.storageState({ path: STATE_PATH });
  console.log(`\nSession saved to ${STATE_PATH}`);
  console.log("Delete that file to log in as somebody else.");

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
