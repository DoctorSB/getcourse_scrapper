// Checks the one behaviour that must never be wrong: a local file is deleted
// only after the upload has been verified. The Yandex Disk client is replaced
// with a stub, so this test touches no network and no real account.
//
//   node jobs/upload.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STUB = path.join(os.tmpdir(), "yadisk-stub-" + process.pid + ".js");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// Builds a stub yadisk module whose behaviour is driven by an env var.
function writeStub() {
  fs.writeFileSync(
    STUB,
    `
const fs = require("fs");
const mode = process.env.STUB_MODE;
const remote = new Map();

exports.safeMessage = (e) => (e && e.message) || String(e);
exports.diskInfo = async () => ({ total_space: 1e12, used_space: 0 });
exports.ensureDir = async () => {};
exports.basePath = () => process.env.YADISK_BASE_PATH || "disk:/test";
exports.hasToken = () => true;
exports.loadCredentials = () => ({ token: "stub", basePath: exports.basePath() });

exports.stat = async (p) => {
  if (mode === "writeonly") {
    const e = new Error("не удалось прочитать " + p + ": HTTP 403");
    e.forbidden = true;
    throw e;
  }
  if (!remote.has(p)) return null;
  return { size: remote.get(p), path: p };
};

exports.upload = async (localPath, remotePath) => {
  const size = fs.statSync(localPath).size;
  if (mode === "fail") throw new Error("сеть отвалилась");
  if (mode === "truncated") { remote.set(remotePath, Math.max(1, size - 10)); return { size }; }
  if (mode === "missing") { return { size }; }   // upload "succeeds", nothing lands
  remote.set(remotePath, size);
  return { size };
};
`
  );
}

// Runs the uploader against a throwaway download folder.
function runCase({ mode, makePartFile = false, fileAgeMs = 120000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-upload-"));
  const nested = path.join(dir, "Курс", "Модуль 1");
  fs.mkdirSync(nested, { recursive: true });

  const video = path.join(nested, "Урок 1.mp4");
  fs.writeFileSync(video, Buffer.alloc(4096, 7));

  if (makePartFile) fs.writeFileSync(video + ".part", "x");

  const when = Date.now() - fileAgeMs;
  fs.utimesSync(video, when / 1000, when / 1000);

  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, "jobs", "upload.js")],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        STUB_MODE: mode,
        YADISK_TOKEN: "stub-token",
        YADISK_BASE_PATH: "disk:/test",
        SCRAPPER_DOWNLOAD_PATH: dir,
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "stub-hook.js"))}`,
        STUB_PATH: STUB,
      },
    }
  );

  return { dir, video, out, exists: fs.existsSync(video) };
}

// Redirects require("…/jobs/yadisk.js") to the stub.
fs.writeFileSync(
  path.join(__dirname, "stub-hook.js"),
  `
const Module = require("module");
const path = require("path");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.endsWith("yadisk.js")) return process.env.STUB_PATH;
  return original.call(this, request, ...rest);
};
`
);

writeStub();

console.log("\nУдаление локального файла происходит только при подтверждённой выгрузке:\n");

{
  const r = runCase({ mode: "ok" });
  check("успешная выгрузка → локальный файл удалён", !r.exists);
  check(
    "пустые папки убраны",
    !fs.existsSync(path.join(r.dir, "Курс")),
    "остался каталог Курс/"
  );
}

{
  const r = runCase({ mode: "fail" });
  check("ошибка сети → файл на месте", r.exists);
  check("ошибка попала в вывод", /ОШИБКА/.test(r.out));
}

{
  const r = runCase({ mode: "truncated" });
  check("размер на Диске не совпал → файл на месте", r.exists);
  check("причина названа", /размер на Диске/.test(r.out));
}

{
  const r = runCase({ mode: "missing" });
  check("файл не появился на Диске → файл на месте", r.exists);
  check("причина названа", /не найден/.test(r.out));
}

{
  const r = runCase({ mode: "ok", makePartFile: true });
  check("незавершённая закачка (.part) → не трогаем", r.exists);
}

{
  // Token with cloud_api:disk.write but no .read — upload goes through, but the
  // result cannot be confirmed, so the only copy must stay.
  const r = runCase({ mode: "writeonly" });
  check("нет права на чтение → файл на месте", r.exists);
  check("причина названа", /disk\.read/.test(r.out), r.out.slice(-200));
}

{
  const r = runCase({ mode: "ok", fileAgeMs: 1000 });
  check("файл изменён секунду назад → ждём, не трогаем", r.exists);
}

try {
  fs.unlinkSync(STUB);
  fs.unlinkSync(path.join(__dirname, "stub-hook.js"));
} catch {}

console.log(`\nпройдено ${passed}, провалено ${failed}\n`);
process.exit(failed ? 1 : 0);
