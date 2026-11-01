// Local web UI for the scraper. Binds to 127.0.0.1 only — it drives a browser
// logged into your account and spawns downloads, so it must not be reachable
// from the network.
//
//   node ui/server.js        # then open http://127.0.0.1:4321

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const browser = require(path.join(ROOT, "scraper", "browser.js"));
const discover = require(path.join(ROOT, "scraper", "discover.js"));
const pipeline = require(path.join(ROOT, "scraper", "pipeline.js"));
const yadisk = require(path.join(ROOT, "jobs", "yadisk.js"));
const uploader = require(path.join(ROOT, "jobs", "uploader.js"));

// Loopback by default. In a container there is no loopback to publish, so the
// image sets 0.0.0.0 and compose publishes the port to 127.0.0.1 on the host.
const HOST = process.env.SCRAPPER_UI_HOST || "127.0.0.1";
const PORT = Number(process.env.SCRAPPER_UI_PORT) || 4321;

// Browsers reach the page over loopback whatever the bind address is. 0.0.0.0
// is included because that is what a container binds to, and people do type it.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
  `http://0.0.0.0:${PORT}`,
]);

// The bind address is not necessarily an address you can open.
const BROWSE_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;

// ---------------------------------------------------------------- event bus

const clients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ------------------------------------------------------------------- state

let job = null; // active pipeline control
let loginSession = null; // { browser, context }
let discovering = false;

// The upload job lives as long as the service does: it is started at boot when
// Yandex Disk is connected, and stopped when the service exits.
let watcher = null;
let uploadState = { lastPass: null, current: null, uploaded: 0, freed: 0, failed: 0 };

const UPLOAD_INTERVAL_MS = Number(process.env.YADISK_INTERVAL_SECONDS || 120) * 1000;

function onUploadEvent(ev) {
  // Also to stdout: in Docker the container log is the only place a user looks.
  if (ev.type === "upload-start") console.log(`[выгрузка] ↑ ${ev.name} (${uploader.humanSize(ev.size)})`);
  if (ev.type === "upload-done") console.log(`[выгрузка] ✓ ${ev.name} — локальный удалён`);
  if (ev.type === "upload-error") console.log(`[выгрузка] ✗ ${ev.name}: ${ev.error}`);
  if (ev.type === "upload-pass-done" && (ev.uploaded || ev.failed)) {
    console.log(`[выгрузка] проход завершён: ${ev.uploaded} шт., освобождено ${ev.freedHuman}`);
  }

  if (ev.type === "upload-start") uploadState.current = { name: ev.name, size: ev.size, percent: 0 };
  if (ev.type === "upload-progress" && uploadState.current) uploadState.current.percent = ev.percent;
  if (ev.type === "upload-done") {
    uploadState.current = null;
    uploadState.uploaded++;
    uploadState.freed += ev.size || 0;
  }
  if (ev.type === "upload-error") {
    uploadState.current = null;
    uploadState.failed++;
  }
  if (ev.type === "upload-pass-done") {
    uploadState.lastPass = { at: new Date().toISOString(), ...ev };
  }
  broadcast(ev);
}

function startWatcher() {
  if (watcher || !yadisk.hasToken()) return false;
  watcher = uploader.startWatcher({
    onEvent: onUploadEvent,
    intervalMs: UPLOAD_INTERVAL_MS,
  });
  broadcast({ type: "upload-watcher", running: true });
  return true;
}

function stopWatcher() {
  if (!watcher) return false;
  watcher.stop();
  watcher = null;
  broadcast({ type: "upload-watcher", running: false });
  return true;
}

// ffmpeg takes a single dash; yt-dlp takes two.
function toolPresent(bin, versionFlag) {
  return new Promise((resolve) => {
    execFile(bin, [versionFlag], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function status() {
  const [ffmpeg, ytdlp] = await Promise.all([
    toolPresent("ffmpeg", "-version"),
    toolPresent("yt-dlp", "--version"),
  ]);

  let trainings = null;
  let trainingsError = null;
  try {
    trainings = discover.loadTrainings();
  } catch (err) {
    trainingsError = err.message;
  }

  return {
    baseURL: process.env.SCRAPPER_BASE_URL || null,
    configDir: process.env.SCRAPPER_TRAINING_CONFIG_DIR || null,
    downloadPath: process.env.SCRAPPER_DOWNLOAD_PATH || null,
    loggedIn: browser.hasSavedSession(),
    loginOpen: Boolean(loginSession),
    headedLogin: HEADED_LOGIN_AVAILABLE,
    inContainer: fs.existsSync("/.dockerenv"),
    ffmpeg,
    ytdlp,
    running: Boolean(job),
    discovering,
    trainings,
    trainingsError,
    yadisk: {
      connected: yadisk.hasToken(),
      basePath: yadisk.basePath(),
      fromEnv: Boolean(process.env.YADISK_TOKEN),
      watching: Boolean(watcher),
      intervalSeconds: UPLOAD_INTERVAL_MS / 1000,
      ...uploadState,
    },
  };
}

// Disk quota, fetched only when asked — it is a network call.
async function yadiskInfo() {
  if (!yadisk.hasToken()) return { connected: false };

  try {
    const info = await yadisk.diskInfo();
    return {
      connected: true,
      total: info.total_space,
      used: info.used_space,
      free: info.total_space - info.used_space,
      totalHuman: uploader.humanSize(info.total_space),
      freeHuman: uploader.humanSize(info.total_space - info.used_space),
    };
  } catch (err) {
    return { connected: false, error: yadisk.safeMessage(err) };
  }
}

async function yadiskConnect({ token, basePath }) {
  if (!token || typeof token !== "string" || token.length < 10) {
    throw new Error("Укажите токен");
  }
  if (basePath && !/^disk:\/[^\0]*$/.test(basePath)) {
    throw new Error("Путь должен начинаться с disk:/");
  }

  // Validate before storing, so a bad token never lands on disk.
  const info = await yadisk.checkToken(token.trim());

  yadisk.saveCredentials({ token: token.trim(), basePath: (basePath || "").trim() || undefined });

  stopWatcher();
  startWatcher();

  return {
    ok: true,
    free: uploader.humanSize(info.total_space - info.used_space),
    total: uploader.humanSize(info.total_space),
  };
}

function yadiskDisconnect() {
  stopWatcher();
  yadisk.clearCredentials();
  if (process.env.YADISK_TOKEN) {
    return { ok: true, note: "Токен из .env продолжает действовать — уберите его там." };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ actions

// A container has no display, so the headed login window cannot be opened there.
const HEADED_LOGIN_AVAILABLE =
  !fs.existsSync("/.dockerenv") && process.env.SCRAPPER_NO_HEADED !== "1";

async function loginStart() {
  if (!HEADED_LOGIN_AVAILABLE) {
    throw new Error(
      "Окно браузера недоступно в контейнере — войдите через cookie (кнопка рядом)"
    );
  }
  if (loginSession) return { ok: true, already: true };

  const base = process.env.SCRAPPER_BASE_URL;
  if (!base) throw new Error("SCRAPPER_BASE_URL не задан в .env");

  const { chromium } = require("playwright");
  const b = await chromium.launch({ headless: false });
  const context = await b.newContext({ locale: "ru-RU" });
  const page = await context.newPage();

  loginSession = { browser: b, context };

  b.on("disconnected", () => {
    loginSession = null;
    broadcast({ type: "login-closed" });
  });

  await page.goto(base, { waitUntil: "load" }).catch(() => {});

  return { ok: true };
}

async function loginFinish() {
  if (!loginSession) throw new Error("Окно входа не открыто");

  await loginSession.context.storageState({ path: browser.STATE_PATH });
  await loginSession.browser.close().catch(() => {});
  loginSession = null;

  // The scraping context caches the session it was built with.
  await browser.reset().catch(() => {});

  return { ok: true, savedTo: browser.STATE_PATH };
}

async function loginCancel() {
  if (loginSession) {
    await loginSession.browser.close().catch(() => {});
    loginSession = null;
  }
  return { ok: true };
}

async function runDiscover(urls) {
  if (discovering) throw new Error("Поиск уже идёт");
  if (job) throw new Error("Сначала остановите загрузку");

  discovering = true;
  broadcast({ type: "discover-start" });

  try {
    const base = (process.env.SCRAPPER_BASE_URL || "").replace(/\/$/, "");

    let streamPaths;
    if (Array.isArray(urls) && urls.length) {
      streamPaths = urls.map((u) => discover.toPath(String(u), base)).filter(Boolean);
      if (!streamPaths.length) throw new Error(`Адреса не с сайта ${base}`);
    } else {
      streamPaths = await discover.findCourses(broadcast);
      if (!streamPaths.length) {
        throw new Error(
          "Курсы не найдены. Войдите в аккаунт, либо вставьте адрес курса вручную."
        );
      }
    }

    const trainings = await discover.findLessons(streamPaths, broadcast);
    const total = trainings.reduce((n, t) => n + t.paths.length, 0);
    if (!total) throw new Error("Уроков не найдено — возможно, сессия истекла.");

    const { backup } = discover.saveTrainings(trainings);
    broadcast({ type: "discover-done", trainings, backup: Boolean(backup) });

    return { ok: true, trainings };
  } finally {
    discovering = false;
    await browser.close().catch(() => {});
  }
}

async function startDownload(trainings) {
  if (job) throw new Error("Загрузка уже идёт");
  if (!Array.isArray(trainings) || !trainings.length) throw new Error("Ничего не выбрано");

  const clean = trainings
    .map((t) => ({
      title: String(t.title || "untitled"),
      paths: Array.isArray(t.paths) ? t.paths.map(String) : [],
    }))
    .filter((t) => t.paths.length);

  if (!clean.length) throw new Error("Ничего не выбрано");

  job = await pipeline.run({ trainings: clean, onEvent: broadcast });

  job.finished
    .catch((err) => broadcast({ type: "fatal", error: err.message }))
    .finally(() => {
      job = null;
      broadcast({ type: "idle" });
    });

  return { ok: true };
}

async function stopDownload() {
  if (!job) return { ok: true, already: true };
  job.stop();
  return { ok: true };
}

// -------------------------------------------------------------------- http

function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    // This page drives a logged-in browser session; no embedding, no referrers.
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(data);
}

function readJson(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Запрос слишком большой"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // A browser page on another origin must not be able to poke these endpoints.
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return send(res, 403, { error: "Запрос с другого источника" });
    }
  }

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return send(res, 200, await status());
    }

    if (req.method === "GET" && url.pathname === "/api/yadisk/info") {
      return send(res, 200, await yadiskInfo());
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);

      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);

      switch (url.pathname) {
        case "/api/login/start":
          return send(res, 200, await loginStart());
        case "/api/login/finish":
          return send(res, 200, await loginFinish());
        case "/api/login/cancel":
          return send(res, 200, await loginCancel());
        case "/api/login/cookie": {
          const domain = browser.saveSessionFromCookie(body);
          await browser.reset().catch(() => {});
          return send(res, 200, { ok: true, domain });
        }
        case "/api/discover":
          return send(res, 200, await runDiscover(body.urls));
        case "/api/download":
          return send(res, 200, await startDownload(body.trainings));
        case "/api/stop":
          return send(res, 200, await stopDownload());
        case "/api/yadisk/connect":
          return send(res, 200, await yadiskConnect(body));
        case "/api/yadisk/disconnect":
          return send(res, 200, yadiskDisconnect());
        case "/api/yadisk/upload-now":
          if (!yadisk.hasToken()) throw new Error("Яндекс Диск не подключён");
          uploader
            .runPass({ onEvent: onUploadEvent })
            .catch((err) =>
              broadcast({ type: "upload-error", name: "—", error: yadisk.safeMessage(err) })
            );
          return send(res, 200, { ok: true });
        case "/api/yadisk/watch":
          return send(res, 200, {
            ok: true,
            watching: body.enabled === false ? (stopWatcher(), false) : (startWatcher(), Boolean(watcher)),
          });
      }
    }

    return send(res, 404, { error: "Не найдено" });
  } catch (err) {
    return send(res, 400, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Интерфейс: http://${BROWSE_HOST}:${PORT}\n`);
  console.log(`  Сайт:      ${process.env.SCRAPPER_BASE_URL || "не задан в .env"}`);
  console.log(`  Папка:     ${process.env.SCRAPPER_DOWNLOAD_PATH || "не задана в .env"}`);

  if (yadisk.hasToken()) {
    startWatcher();
    console.log(`  Выгрузка:  ${yadisk.basePath()}, проверка каждые ${UPLOAD_INTERVAL_MS / 1000} с`);
  } else {
    console.log(`  Выгрузка:  не подключена (настраивается в интерфейсе)`);
  }

  console.log(`\n  Ctrl-C — выход.\n`);
});

let shuttingDown = false;

async function shutdown() {
  // A second signal means "stop asking nicely".
  if (shuttingDown) process.exit(1);
  shuttingDown = true;

  console.log("\nЗавершаюсь...");

  stopWatcher();
  if (job) job.stop();

  // Closing Chromium can hang when pages are mid-navigation, and a service that
  // refuses to die is worse than one that drops a browser process.
  const cleanup = Promise.all([
    loginCancel().catch(() => {}),
    browser.close().catch(() => {}),
  ]);

  await Promise.race([cleanup, new Promise((r) => setTimeout(r, 5000))]);

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
