const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STATE_PATH = path.join(__dirname, "..", "auth-state.json");

let browserPromise = null;
let contextPromise = null;

function authState() {
  // Not just "the file exists": compose creates an empty placeholder so the
  // bind mount is a file rather than a directory, and Playwright cannot parse it.
  if (exports.hasSavedSession()) {
    return { storageState: STATE_PATH };
  }

  const name = process.env.SCRAPPER_AUTH_COOKIE_NAME;
  const value = process.env.SCRAPPER_AUTH_COOKIE_VALUE;
  const domain = process.env.SCRAPPER_AUTH_COOKIE_DOMAIN;

  if (!name || !value || !domain) {
    throw new Error(
      `No credentials. Either run "node cmd/login.js" (interactive login, saves ${path.basename(STATE_PATH)}) ` +
        `or set SCRAPPER_AUTH_COOKIE_NAME / _VALUE / _DOMAIN in .env`
    );
  }

  return {
    storageState: {
      cookies: [
        {
          name,
          value,
          domain,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        },
      ],
      origins: [],
    },
  };
}

function getContext() {
  if (!contextPromise) {
    const config = require(path.join(__dirname, "..", "config", "config.json"));
    const settings = config.scrapper.browser.webpage;

    browserPromise = chromium.launch({ headless: true });
    contextPromise = browserPromise.then((browser) =>
      browser.newContext({
        userAgent: settings.settings.userAgent,
        viewport: settings.viewportSize,
        locale: "ru-RU",
        ...authState(),
      })
    );
  }
  return contextPromise;
}

// Returns the fully rendered HTML of `url`, including the content of every
// iframe. getcourse puts the player (and therefore masterPlaylistUrl) inside an
// iframe, so the frames are what the parser actually needs.
exports.fetch = async function (url) {
  console.log(`Fetch ${url}`);

  const context = await getContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });

    // The player mounts after load; give it a moment, then settle on network idle.
    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});

    let html = await page.content();

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        html += await frame.content();
      } catch {
        // Frame navigated or detached mid-read — skip it.
      }
    }

    return html;
  } finally {
    await page.close();
  }
};

exports.close = async function () {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
    contextPromise = null;
  }
};

// The auth state is read once, when the context is created. Call this after a
// fresh login so the next fetch picks the new session up.
exports.reset = exports.close;

exports.hasSavedSession = function () {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return Array.isArray(saved.cookies) && saved.cookies.length > 0;
  } catch {
    return false;
  }
};

// Builds a session from a cookie copied out of the user's own browser. This is
// the login path when no window can be opened — inside a container, over SSH.
exports.saveSessionFromCookie = function ({ name, value, domain }) {
  if (!name || !value) throw new Error("Укажите имя и значение cookie");

  let host = (domain || "").trim();
  if (!host) {
    const base = process.env.SCRAPPER_BASE_URL;
    if (!base) throw new Error("Укажите домен cookie");
    host = "." + new URL(base).hostname;
  }
  if (!host.startsWith(".")) host = "." + host.replace(/^https?:\/\//, "");

  const state = {
    cookies: [
      {
        name: String(name).trim(),
        value: String(value).trim(),
        domain: host,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
      },
    ],
    origins: [],
  };

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return state.cookies[0].domain;
};

exports.STATE_PATH = STATE_PATH;
