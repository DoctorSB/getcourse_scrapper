// Upload pass + watcher, shared by the CLI (jobs/upload.js), the launchd job
// and the web UI. Everything is reported through `onEvent`.
//
// A local file is deleted ONLY after the upload has been verified: the remote
// resource must exist and its size must match the local size byte for byte.

const fs = require("fs");
const path = require("path");

const yadisk = require(path.join(__dirname, "yadisk.js"));

const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".m4v", ".mov"]);
// yt-dlp writes these next to the target while a download is in flight.
const IN_PROGRESS_EXT = [".part", ".ytdl", ".temp"];
// A file touched this recently might still be being written.
const SETTLE_MS = 60 * 1000;

const LOCK_PATH = path.join(__dirname, "..", "logs", ".upload.lock");

// --------------------------------------------------------------------- lock

// Keeps the UI watcher, a manual run and the launchd job from uploading the
// same file at the same time.
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  // Stale lock from a process that is no longer running?
  const owner = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
  if (owner && owner !== process.pid) {
    try {
      process.kill(owner, 0);
      return false; // still alive
    } catch {
      // gone — take it over
    }
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    const owner = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
    if (owner === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

// ---------------------------------------------------------------- utilities

function humanSize(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function localRoot() {
  const root = process.env.SCRAPPER_DOWNLOAD_PATH;
  if (!root) throw new Error("SCRAPPER_DOWNLOAD_PATH не задан");
  return root;
}

function walk(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

// A download is finished when no sibling temp file remains and the video has
// not been written to for a little while.
function isSettled(file) {
  for (const ext of IN_PROGRESS_EXT) {
    if (fs.existsSync(file + ext)) return false;
  }

  const base = file.replace(/\.[^.]+$/, "");
  for (const ext of IN_PROGRESS_EXT) {
    if (fs.existsSync(base + ext)) return false;
  }

  try {
    return Date.now() - fs.statSync(file).mtimeMs > SETTLE_MS;
  } catch {
    return false;
  }
}

function remotePathFor(localFile, root, base) {
  const relative = path.relative(root, localFile);
  return `${base}/${relative.split(path.sep).join("/")}`;
}

// After a file is removed, drop any folders it left empty.
function pruneEmptyDirs(fromDir, root) {
  let dir = fromDir;
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

exports.humanSize = humanSize;

// -------------------------------------------------------------------- upload

async function handleFile(file, { root, base, dirCache, emit, dryRun, stats }) {
  const remote = remotePathFor(file, root, base);
  const localSize = fs.statSync(file).size;
  const name = path.basename(file);

  if (localSize === 0) {
    emit({ type: "upload-skip", name, reason: "пустой файл" });
    return;
  }

  // Already there from an earlier run? Then this pass only has to clean up.
  // This lookup is an optimisation: without cloud_api:disk.read we simply
  // upload again rather than refusing to work.
  let existing = null;
  try {
    existing = await yadisk.stat(remote);
  } catch (err) {
    if (!err.forbidden) throw err;
    emit({ type: "upload-noread" });
  }

  if (existing && existing.size === localSize) {
    if (dryRun) {
      emit({ type: "upload-skip", name, reason: "уже на Диске (удалил бы локально)" });
      return;
    }
    fs.unlinkSync(file);
    pruneEmptyDirs(path.dirname(file), root);
    stats.alreadyThere++;
    stats.freed += localSize;
    emit({ type: "upload-done", name, size: localSize, note: "уже была на Диске" });
    return;
  }

  if (dryRun) {
    emit({ type: "upload-skip", name, reason: `выгрузил бы (${humanSize(localSize)})` });
    return;
  }

  await yadisk.ensureDir(path.posix.dirname(remote), dirCache);

  emit({ type: "upload-start", name, size: localSize, remote });

  const started = Date.now();
  let lastPercent = -1;

  await yadisk.upload(file, remote, (sent, total) => {
    const percent = Math.floor((sent / total) * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      emit({ type: "upload-progress", name, percent, sent, total });
    }
  });

  // Verification gate: the local file is only removed once the Disk confirms a
  // resource of exactly the same size. 202 Accepted means it is still assembling.
  let remoteInfo = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      remoteInfo = await yadisk.stat(remote);
    } catch (err) {
      if (err.forbidden) {
        // Without read access the upload cannot be confirmed, and an
        // unconfirmed upload is not grounds for deleting the only copy.
        throw new Error(
          "выгружено, но проверить нельзя: нет права cloud_api:disk.read — " +
            "локальный файл оставляю"
        );
      }
      throw err;
    }
    if (remoteInfo && remoteInfo.size === localSize) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }

  if (!remoteInfo) {
    throw new Error("после выгрузки файл на Диске не найден — локальный не трогаю");
  }
  if (remoteInfo.size !== localSize) {
    throw new Error(
      `размер на Диске ${humanSize(remoteInfo.size)} ≠ локальный ${humanSize(localSize)} — локальный не трогаю`
    );
  }

  fs.unlinkSync(file);
  pruneEmptyDirs(path.dirname(file), root);

  const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
  stats.uploaded++;
  stats.freed += localSize;

  emit({
    type: "upload-done",
    name,
    size: localSize,
    seconds,
    speed: humanSize(localSize / seconds) + "/с",
  });
}

// One sweep over the download folder.
exports.runPass = async function ({ onEvent, dryRun = false } = {}) {
  const emit = onEvent || (() => {});
  const stats = { uploaded: 0, alreadyThere: 0, skipped: 0, failed: 0, freed: 0 };

  if (!acquireLock()) {
    emit({ type: "upload-busy" });
    return stats;
  }

  try {
    const root = localRoot();
    if (!fs.existsSync(root)) {
      emit({ type: "upload-idle", reason: "папка загрузок ещё не создана" });
      return stats;
    }

    const base = yadisk.basePath();
    const dirCache = new Set();

    const all = walk(root);
    const ready = all.filter(isSettled);
    stats.skipped = all.length - ready.length;

    emit({ type: "upload-pass-start", total: all.length, ready: ready.length, busy: stats.skipped });

    for (const file of ready) {
      try {
        await handleFile(file, { root, base, dirCache, emit, dryRun, stats });
      } catch (err) {
        stats.failed++;
        emit({
          type: "upload-error",
          name: path.basename(file),
          error: yadisk.safeMessage(err),
        });
      }
    }

    emit({ type: "upload-pass-done", ...stats, freedHuman: humanSize(stats.freed) });
    return stats;
  } finally {
    releaseLock();
  }
};

// Repeats runPass on an interval. Returns a handle with stop().
exports.startWatcher = function ({ onEvent, intervalMs = 120000 } = {}) {
  const emit = onEvent || (() => {});
  let timer = null;
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      await exports.runPass({ onEvent: emit });
    } catch (err) {
      emit({ type: "upload-error", name: "—", error: yadisk.safeMessage(err) });
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get active() {
      return running;
    },
  };
};
