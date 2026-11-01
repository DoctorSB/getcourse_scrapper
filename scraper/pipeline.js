// The scrape-and-download pipeline, shared by the CLI (main.js) and the web UI
// (ui/server.js). Everything it does is reported through `onEvent` so a caller
// can log it, stream it over SSE, or ignore it.

const path = require("path");
const cheerio = require("cheerio");

const { fetch, close } = require(path.join(__dirname, "browser.js"));
const { MD5 } = require(path.join(__dirname, "..", "lib", "md5"));
const { createDownloader } = require(path.join(__dirname, "download.js"));

const config = require(path.join(__dirname, "..", "config", "config.json"));

const MAX_ATTEMPTS = 3;

// Titles come from the page, so they must not be able to escape the output
// directory or inject path separators.
function safeName(name) {
  return (
    name
      .replace(/[\/\\]/g, "-")
      .replace(/[\x00-\x1f]/g, "")
      .replace(/^\.+/, "")
      .trim() || "untitled"
  );
}

// Upstream's directory naming: strip anything exotic, and turn ". " into a
// nesting level so "Course. Module" becomes "Course/Module".
function trainingDir(title) {
  return title
    .replace(/[^a-zA-Zа-яА-Я0-9-_.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.\s+/g, "/");
}

// Player URLs are pulled out of inline JSON (`"masterPlaylistUrl":"https:\/\/..."`)
// and out of HTML attributes, so they arrive both JSON- and HTML-escaped.
function decodeVideoUrl(raw) {
  const url = raw
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, "&")
    .trim();

  // The YouTube pattern also matches protocol-relative hrefs.
  return url.startsWith("//") ? "https:" + url : url;
}

function videoUrlsIn(html) {
  const $ = cheerio.load(html);
  const bodyHtml = $("body").html() || "";
  const lessonTitle = $("h2").first().text().trim().replace(/\.$/, "");

  const found = [];
  const seen = new Set();

  for (const pattern of config.scrapper.parser.patterns) {
    const regex = new RegExp(pattern, config.scrapper.parser.flags);
    let matched;
    while ((matched = regex.exec(bodyHtml)) !== null) {
      const raw = matched.groups && matched.groups.url;
      if (!raw) continue;

      const videoUrl = decodeVideoUrl(raw);
      if (!/^https?:\/\/[^\/]+\//i.test(videoUrl)) continue;

      const hash = MD5(videoUrl);
      if (seen.has(hash)) continue;

      seen.add(hash);
      found.push(videoUrl);
    }
  }

  return { lessonTitle, videoUrls: found };
}

// trainings: [{ title, paths: [...] }]
exports.run = async function ({ trainings, onEvent, baseURL, downloadPath } = {}) {
  const emit = onEvent || (() => {});

  const base = (baseURL || process.env.SCRAPPER_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("SCRAPPER_BASE_URL is not set");

  let root = downloadPath || process.env.SCRAPPER_DOWNLOAD_PATH;
  if (!root) throw new Error("SCRAPPER_DOWNLOAD_PATH is not set");
  // Relative paths count from the project root, whatever directory we run from.
  root = path.resolve(__dirname, "..", root) + path.sep;

  const concurrency = Number(process.env.SCRAPPER_CONCURRENCY) || 3;

  const downloader = createDownloader({
    template: config.scrapper.downloader.cmdTemplate,
    concurrency: Number(process.env.SCRAPPER_DOWNLOAD_CONCURRENCY) || 2,
    onEvent: emit,
  });

  let stopped = false;

  const lessonTotal = trainings.reduce((n, t) => n + t.paths.length, 0);
  let lessonsDone = 0;

  emit({ type: "start", trainings: trainings.length, lessons: lessonTotal });

  async function handleLesson(url, outVideoDir, attempt = 1) {
    if (stopped) return;

    let html;
    try {
      html = await fetch(url);
    } catch (err) {
      const message = typeof err === "string" ? err : err.message;
      if (attempt < MAX_ATTEMPTS && !stopped) {
        emit({ type: "lesson-retry", url, attempt: attempt + 1, max: MAX_ATTEMPTS, error: message });
        return handleLesson(url, outVideoDir, attempt + 1);
      }
      emit({ type: "lesson-error", url, error: message });
      lessonsDone++;
      emit({ type: "lesson-progress", done: lessonsDone, total: lessonTotal });
      return;
    }

    const { lessonTitle, videoUrls } = videoUrlsIn(html);
    const extension = config.scrapper.downloader.outVideo.extension;

    videoUrls.forEach((videoUrl, i) => {
      const name = safeName(lessonTitle) + (i > 0 ? `-${i + 1}` : "");
      const relative = outVideoDir.endsWith("/") ? outVideoDir : outVideoDir + "/";
      downloader.enqueue(videoUrl, `${root}${relative}${name}.${extension}`, name);
    });

    if (!videoUrls.length) emit({ type: "lesson-novideo", url, title: lessonTitle });
    else emit({ type: "lesson-done", url, title: lessonTitle, videos: videoUrls.length });

    lessonsDone++;
    emit({ type: "lesson-progress", done: lessonsDone, total: lessonTotal });
  }

  const control = {
    stop() {
      stopped = true;
      downloader.cancel();
    },
  };

  const finished = (async () => {
    try {
      for (let i = 0; i < trainings.length; i++) {
        if (stopped) break;

        const training = trainings[i];
        emit({
          type: "training-start",
          index: i,
          total: trainings.length,
          title: training.title,
        });

        const outVideoDir = trainingDir(training.title);
        const queue = training.paths.slice();

        const worker = async () => {
          let lessonPath;
          while (!stopped && (lessonPath = queue.shift()) !== undefined) {
            await handleLesson(base + lessonPath, outVideoDir);
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, queue.length) }, worker)
        );
      }

      emit({ type: "scraping-done", downloads: downloader.queued });
      await downloader.drain();
      emit({ type: "done", stopped });
    } catch (err) {
      emit({ type: "fatal", error: err.message });
      throw err;
    } finally {
      await close().catch(() => {});
    }
  })();

  control.finished = finished;
  return control;
};

exports.safeName = safeName;
exports.trainingDir = trainingDir;
