// CLI for the uploader. The work lives in jobs/uploader.js, which the web UI
// and the launchd job drive too.
//
//   node jobs/upload.js              # one pass over the download folder
//   node jobs/upload.js --watch      # keep running, re-checking periodically
//   node jobs/upload.js --dry-run    # show what would happen, change nothing

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const yadisk = require(path.join(__dirname, "yadisk.js"));
const uploader = require(path.join(__dirname, "uploader.js"));

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const WATCH = args.includes("--watch");
const INTERVAL_S =
  Number((args.find((a) => a.startsWith("--interval=")) || "").split("=")[1]) || 300;

const LOG_FILE = path.join(__dirname, "..", "logs", "upload.log");

function log(line) {
  const stamped = `${new Date().toISOString().replace("T", " ").slice(0, 19)}  ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // Logging must never break the job.
  }
}

function onEvent(ev) {
  switch (ev.type) {
    case "upload-busy":
      log("другая выгрузка уже идёт — пропускаю проход");
      break;
    case "upload-idle":
      log(ev.reason);
      break;
    case "upload-pass-start":
      log(
        `файлов: ${ev.total}, готовых: ${ev.ready}` +
          (ev.busy ? `, ещё качаются: ${ev.busy}` : "")
      );
      break;
    case "upload-start":
      log(`выгружаю: ${ev.name} (${uploader.humanSize(ev.size)})`);
      break;
    case "upload-progress":
      if (ev.percent % 20 === 0) log(`    ${ev.percent}%`);
      break;
    case "upload-done":
      log(
        ev.note
          ? `${ev.name} — ${ev.note}, локальный удалён`
          : `готово: ${ev.name} — ${uploader.humanSize(ev.size)} за ${ev.seconds} с (${ev.speed}), локальный удалён`
      );
      break;
    case "upload-skip":
      log(`пропуск: ${ev.name} — ${ev.reason}`);
      break;
    case "upload-error":
      log(`ОШИБКА ${ev.name}: ${ev.error}`);
      break;
    case "upload-pass-done":
      log(
        `итог: выгружено ${ev.uploaded}, было на Диске ${ev.alreadyThere}, ` +
          `ошибок ${ev.failed}, освобождено ${ev.freedHuman}`
      );
      break;
  }
}

(async () => {
  // Quota is nice to know but not required to upload, so a missing
  // cloud_api:disk.info scope must not stop the job.
  try {
    const info = await yadisk.diskInfo();
    const free = info.total_space - info.used_space;
    log(
      `Яндекс Диск: свободно ${uploader.humanSize(free)} из ${uploader.humanSize(info.total_space)}`
    );
  } catch (err) {
    log(`Яндекс Диск: место узнать не вышло (${yadisk.safeMessage(err)}) — продолжаю`);
  }

  log(`откуда: ${process.env.SCRAPPER_DOWNLOAD_PATH}`);
  log(`куда:   ${yadisk.basePath()}`);
  if (DRY_RUN) log("режим проверки — ничего не меняю");

  if (!WATCH) {
    await uploader.runPass({ onEvent, dryRun: DRY_RUN });
    return;
  }

  log(`режим наблюдения, проверка каждые ${INTERVAL_S} с (Ctrl-C — выход)`);
  const watcher = uploader.startWatcher({ onEvent, intervalMs: INTERVAL_S * 1000 });

  const stop = () => {
    watcher.stop();
    log("остановлено");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise(() => {}); // run until signalled
})().catch((err) => {
  log("СБОЙ: " + yadisk.safeMessage(err));
  process.exit(1);
});
