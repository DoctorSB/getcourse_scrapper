// Finds your courses and their lessons, so the lesson list doesn't have to be
// assembled by hand. Used by cmd/discover.js and by the web UI.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const { fetch } = require(path.join(__dirname, "browser.js"));

const LESSON_RE = /\/teach\/control\/lesson\/view\?id=\d+|\/teach\/control\/lesson\/view\/id\/\d+/;
const STREAM_RE = /\/teach\/control\/stream\/view\?id=\d+|\/teach\/control\/stream\/view\/id\/\d+/;

// Same two shapes, but scanned over the whole document rather than over <a href>
// only: on courses with modules the lesson ids often live in data-attributes,
// onclick handlers or inline JSON instead of plain links.
const LESSON_SCAN = /(?:\/pl)?\/teach\/control\/lesson\/view(?:\?id=|\/id\/)(\d+)/g;
const STREAM_SCAN = /(?:\/pl)?\/teach\/control\/stream\/view(?:\?id=|\/id\/)(\d+)/g;

// How deep to follow module pages, and a hard cap so a cross-linked site can't
// turn discovery into a full crawl.
const MAX_DEPTH = 2;
const MAX_PAGES = 60;

// Returns [{ id, path }], first-seen path form per id.
function scanIds(html, regex) {
  const byId = new Map();
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(html)) !== null) {
    if (!byId.has(m[1])) byId.set(m[1], m[0]);
  }
  return [...byId].map(([id, path]) => ({ id, path }));
}

function baseURL() {
  const base = (process.env.SCRAPPER_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("SCRAPPER_BASE_URL is not set");
  return base;
}

// Normalises an href to a same-host path, or null if it points elsewhere.
function toPath(href, base) {
  if (!href) return null;
  try {
    const url = new URL(href, base + "/");
    if (new URL(base).host !== url.host) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

function linksMatching(html, re, base) {
  const $ = cheerio.load(html);
  const found = [];
  $("a[href]").each((_, el) => {
    const p = toPath($(el).attr("href"), base);
    if (p && re.test(p) && !found.includes(p)) found.push(p);
  });
  return found;
}

function titleOf(html, fallback) {
  const $ = cheerio.load(html);
  const h = $("h1").first().text().trim() || $("h2").first().text().trim();
  return (h || fallback).replace(/\s+/g, " ");
}

exports.toPath = toPath;

// Locates course (stream) pages belonging to the logged-in user.
exports.findCourses = async function (onEvent) {
  const emit = onEvent || (() => {});
  const base = baseURL();

  emit({ type: "discover-log", line: "Ищу курсы на /teach/control/stream..." });

  let paths = [];
  try {
    paths = linksMatching(await fetch(base + "/teach/control/stream"), STREAM_RE, base);
  } catch (err) {
    emit({ type: "discover-log", line: `Не вышло: ${err.message}` });
  }

  if (!paths.length) {
    emit({ type: "discover-log", line: "Пусто. Пробую главную страницу..." });
    try {
      const home = await fetch(base);
      paths = linksMatching(home, STREAM_RE, base);
      // Links may be rendered by JS rather than as plain anchors.
      if (!paths.length) paths = scanIds(home, STREAM_SCAN).map((s) => s.path);
    } catch (err) {
      emit({ type: "discover-log", line: `Не вышло: ${err.message}` });
    }
  }

  emit({ type: "discover-log", line: `Найдено курсов: ${paths.length}` });
  return paths;
};

// Expands course pages into { title, paths } entries, following module pages
// so courses that group their lessons are not reported as empty.
exports.findLessons = async function (streamPaths, onEvent) {
  const emit = onEvent || (() => {});
  const base = baseURL();

  const trainings = [];
  const visitedPages = new Set();
  const claimedLessons = new Set(); // lesson id -> already assigned to a training

  const queue = streamPaths.map((path) => ({ path, depth: 0, parent: null }));

  while (queue.length && visitedPages.size < MAX_PAGES) {
    const { path, depth, parent } = queue.shift();

    const pageId = path.replace(/^\/pl/, "");
    if (visitedPages.has(pageId)) continue;
    visitedPages.add(pageId);

    let html;
    try {
      html = await fetch(base + path);
    } catch (err) {
      emit({ type: "discover-log", line: `Ошибка на ${path}: ${err.message}` });
      continue;
    }

    const ownTitle = titleOf(html, path);
    const title = parent && ownTitle !== parent ? `${parent}. ${ownTitle}` : ownTitle;

    const lessons = scanIds(html, LESSON_SCAN).filter((l) => !claimedLessons.has(l.id));

    if (lessons.length) {
      lessons.forEach((l) => claimedLessons.add(l.id));
      trainings.push({ title, paths: lessons.map((l) => l.path) });
      emit({ type: "discover-log", line: `«${title}» — уроков: ${lessons.length}` });
    } else {
      emit({ type: "discover-log", line: `«${title}» — уроков на странице нет` });
    }

    if (depth >= MAX_DEPTH) continue;

    // Module / sub-course pages linked from here.
    const subs = scanIds(html, STREAM_SCAN).filter(
      (s) => !visitedPages.has(s.path.replace(/^\/pl/, ""))
    );

    if (subs.length) {
      emit({
        type: "discover-log",
        line: `  ↳ вложенных разделов: ${subs.length}, захожу внутрь`,
      });
      for (const sub of subs) {
        queue.push({ path: sub.path, depth: depth + 1, parent: title });
      }
    }
  }

  if (visitedPages.size >= MAX_PAGES) {
    emit({
      type: "discover-log",
      line: `Остановился на ${MAX_PAGES} страницах — дальше вглубь не пошёл.`,
    });
  }

  return trainings;
};

exports.trainingsFile = function () {
  const configDir = process.env.SCRAPPER_TRAINING_CONFIG_DIR;
  if (!configDir) throw new Error("SCRAPPER_TRAINING_CONFIG_DIR is not set");
  return path.join(__dirname, "..", "config", "trainings", configDir, "trainings.json");
};

exports.loadTrainings = function () {
  const file = exports.trainingsFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// Writes trainings.json, backing up any previous version first.
exports.saveTrainings = function (trainings) {
  const file = exports.trainingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
  }

  fs.writeFileSync(file, JSON.stringify(trainings, null, 2) + "\n");
  return { file, backup };
};
