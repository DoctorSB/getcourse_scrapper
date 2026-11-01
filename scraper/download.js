// Runs yt-dlp directly, with arguments passed as an argv array.
//
// Upstream printed a shell command string and had cmd/tools/download.sh `eval`
// every line matching yt-dlp. The output path is built from the lesson title
// scraped off the page, so a title containing shell metacharacters was remote
// code execution. Nothing here goes through a shell.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// yt-dlp args from config, with {videoUrl} / {outVideoPath} as standalone
// placeholders. Quotes in the template are stripped: there is no shell to need
// them, and leaving them in would make them part of the literal argument.
function buildArgs(template, videoUrl, outVideoPath) {
  const tokens = template.trim().match(/"[^"]*"|\S+/g) || [];

  return tokens
    .slice(1) // drop the "yt-dlp" program name
    .map((token) => token.replace(/^"|"$/g, ""))
    .map((token) => {
      if (token === "{videoUrl}") return videoUrl;
      if (token === "{outVideoPath}") return outVideoPath;
      return token;
    });
}

// `[download]  12.3% of ~1.00GiB at 4.00MiB/s ETA 02:11`
const PROGRESS_RE = /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/;

exports.createDownloader = function ({ template, onEvent, concurrency }) {
  const limit = Number(concurrency) || 2;
  const emit = onEvent || (() => {});

  const queue = [];
  const settled = [];
  const seen = new Set();
  const running = new Set();

  let active = 0;
  let nextId = 1;
  let cancelled = false;

  function pump() {
    while (!cancelled && active < limit && queue.length) {
      const job = queue.shift();
      active++;
      run(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  function run(job) {
    const { id, args, outVideoPath, title, resolve } = job;

    try {
      fs.mkdirSync(path.dirname(outVideoPath), { recursive: true });
    } catch (err) {
      emit({ type: "download-error", id, title, path: outVideoPath, error: err.message });
      resolve();
      return Promise.resolve();
    }

    emit({ type: "download-start", id, title, path: outVideoPath });

    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);

    let buffer = "";
    let lastPercent = -1;

    const onChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const m = PROGRESS_RE.exec(line);
        if (m) {
          const percent = Math.round(Number(m[1]));
          if (percent !== lastPercent) {
            lastPercent = percent;
            emit({
              type: "download-progress",
              id,
              title,
              percent,
              size: m[2] || null,
              speed: m[3] || null,
              eta: m[4] || null,
            });
          }
        } else if (line.trim()) {
          emit({ type: "log", id, line: line.trim() });
        }
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    return new Promise((done) => {
      child.on("error", (err) => {
        running.delete(child);
        emit({
          type: "download-error",
          id,
          title,
          path: outVideoPath,
          error: err.code === "ENOENT" ? "yt-dlp not found in PATH" : err.message,
        });
        resolve();
        done();
      });

      child.on("exit", (code, sig) => {
        running.delete(child);
        if (code === 0) {
          emit({ type: "download-done", id, title, path: outVideoPath });
        } else if (cancelled || sig) {
          emit({ type: "download-cancelled", id, title, path: outVideoPath });
        } else {
          emit({
            type: "download-error",
            id,
            title,
            path: outVideoPath,
            error: `yt-dlp exited with ${code}`,
          });
        }
        resolve();
        done();
      });
    });
  }

  return {
    // Queues a download. Repeated calls for the same output path collapse.
    enqueue(videoUrl, outVideoPath, title) {
      if (cancelled || seen.has(outVideoPath)) return;
      seen.add(outVideoPath);

      const id = nextId++;
      const args = buildArgs(template, videoUrl, outVideoPath);

      emit({ type: "download-queued", id, title, path: outVideoPath });

      settled.push(
        new Promise((resolve) => {
          queue.push({ id, args, outVideoPath, title, resolve });
          pump();
        })
      );
    },

    // Resolves once every queued download has finished.
    async drain() {
      // Jobs can still be appended while earlier ones run.
      while (settled.length) {
        const pending = settled.splice(0, settled.length);
        await Promise.all(pending);
      }
    },

    cancel() {
      cancelled = true;
      queue.length = 0;
      for (const child of running) child.kill("SIGTERM");
    },

    get queued() {
      return seen.size;
    },
  };
};

exports.buildArgs = buildArgs;
