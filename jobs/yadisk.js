// Minimal Yandex Disk REST client.
//
// The OAuth token is a secret: it is read from the environment, sent only in
// the Authorization header, and never logged or included in error messages.

const fs = require("fs");
const path = require("path");
const https = require("https");

const API = "https://cloud-api.yandex.net/v1/disk";

// Where the UI stores a token entered in the browser. Owner-readable only, and
// gitignored — it grants full access to the account's Disk.
const CREDENTIALS_PATH = path.join(__dirname, "..", "yadisk-auth.json");

exports.CREDENTIALS_PATH = CREDENTIALS_PATH;

exports.loadCredentials = function () {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return null;
  }
};

exports.saveCredentials = function ({ token, basePath }) {
  const data = { token, basePath: basePath || "disk:/getcourse" };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_PATH, 0o600);
  return data;
};

exports.clearCredentials = function () {
  try {
    fs.unlinkSync(CREDENTIALS_PATH);
  } catch {}
};

// .env wins, so an existing terminal setup keeps working; otherwise whatever
// was connected through the UI.
function token() {
  const fromEnv = process.env.YADISK_TOKEN;
  if (fromEnv) return fromEnv;

  const saved = exports.loadCredentials();
  if (saved && saved.token) return saved.token;

  throw new Error("Яндекс Диск не подключён — укажите токен в интерфейсе или в .env");
}

exports.hasToken = function () {
  if (process.env.YADISK_TOKEN) return true;
  const saved = exports.loadCredentials();
  return Boolean(saved && saved.token);
};

exports.basePath = function () {
  const saved = exports.loadCredentials();
  const value = process.env.YADISK_BASE_PATH || (saved && saved.basePath) || "disk:/getcourse";
  return value.replace(/\/+$/, "");
};

// Validates a token without storing it. Quota needs cloud_api:disk.info, which
// uploading does not — so a token with only read/write still counts as valid.
exports.checkToken = async function (candidate) {
  const previous = process.env.YADISK_TOKEN;
  process.env.YADISK_TOKEN = candidate;
  try {
    try {
      return await exports.diskInfo();
    } catch (err) {
      if (!/HTTP 403/.test(err.message)) throw err;

      // No disk.info: fall back to proving the token can read the Disk.
      await exports.stat("disk:/");
      return { total_space: null, used_space: null, limitedScopes: true };
    }
  } finally {
    if (previous === undefined) delete process.env.YADISK_TOKEN;
    else process.env.YADISK_TOKEN = previous;
  }
};

// Resolves to { status, headers, body } — body parsed as JSON when possible.
function request(method, url, { headers = {}, body, stream, onProgress, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: { Authorization: `OAuth ${token()}`, ...headers },
        timeout,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      }
    );

    req.on("error", reject);
    if (timeout) req.on("timeout", () => req.destroy(new Error("таймаут соединения")));

    if (stream) {
      let sent = 0;
      stream.on("data", (chunk) => {
        sent += chunk.length;
        if (onProgress) onProgress(sent);
      });
      stream.on("error", reject);
      stream.pipe(req);
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

// Strips the token out of anything we are about to show a human.
function safeMessage(err) {
  const msg = err && err.message ? err.message : String(err);
  const t = process.env.YADISK_TOKEN;
  return t ? msg.split(t).join("<токен>") : msg;
}

exports.safeMessage = safeMessage;

exports.diskInfo = async function () {
  const res = await request("GET", `${API}/`);
  if (res.status !== 200) {
    throw new Error(describe(res, "не удалось получить сведения о Диске"));
  }
  return res.body;
};

function describe(res, prefix) {
  const detail = res.body && (res.body.message || res.body.description);
  return `${prefix}: HTTP ${res.status}${detail ? " — " + detail : ""}`;
}

// Creates a folder, tolerating "already exists".
async function mkdir(remotePath) {
  const url = `${API}/resources?path=${encodeURIComponent(remotePath)}`;
  const res = await request("PUT", url);
  if (res.status === 201 || res.status === 409) return;
  throw new Error(describe(res, `не удалось создать папку ${remotePath}`));
}

// Creates every missing segment of a remote folder path.
exports.ensureDir = async function (remoteDir, cache = new Set()) {
  const withoutScheme = remoteDir.replace(/^disk:/, "");
  const segments = withoutScheme.split("/").filter(Boolean);

  let current = "disk:";
  for (const segment of segments) {
    current += "/" + segment;
    if (cache.has(current)) continue;
    await mkdir(current);
    cache.add(current);
  }
};

// Returns the resource metadata, or null when it does not exist.
// Throws with .forbidden set when the token lacks cloud_api:disk.read, so
// callers can tell "not there" from "not allowed to look".
exports.stat = async function (remotePath) {
  const url = `${API}/resources?path=${encodeURIComponent(remotePath)}&fields=size,name,path,md5`;
  const res = await request("GET", url);
  if (res.status === 200) return res.body;
  if (res.status === 404) return null;

  const err = new Error(describe(res, `не удалось прочитать ${remotePath}`));
  if (res.status === 403) err.forbidden = true;
  throw err;
};

// Uploads a local file, overwriting any existing remote copy.
exports.upload = async function (localPath, remotePath, onProgress) {
  const url =
    `${API}/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`;

  const link = await request("GET", url);

  if (link.status === 507) {
    throw new Error("на Яндекс Диске не хватает места");
  }
  if (link.status !== 200 || !link.body || !link.body.href) {
    throw new Error(describe(link, "не удалось получить ссылку для загрузки"));
  }

  const size = fs.statSync(localPath).size;
  const stream = fs.createReadStream(localPath);

  const res = await request(link.body.method || "PUT", link.body.href, {
    headers: { "Content-Length": size },
    stream,
    onProgress: onProgress ? (sent) => onProgress(sent, size) : undefined,
  });

  // 201 Created, 202 Accepted (async assembly) are both success.
  if (res.status !== 201 && res.status !== 202) {
    throw new Error(describe(res, "загрузка не удалась"));
  }

  return { size, async: res.status === 202 };
};
