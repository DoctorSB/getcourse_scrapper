// Diagnostic: renders one page the way the scraper sees it and reports what it
// found. Use it when a course reports zero lessons, or a lesson reports no video.
//
//   node cmd/dump.js /teach/control/stream/view/id/123456
//   node cmd/dump.js https://site.ru/teach/control/lesson/view/id/789
//
// Writes the rendered HTML to logs/getcourse-dump.html for a closer look.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fetch, close } = require(path.join(__dirname, "..", "scraper", "browser.js"));
const discover = require(path.join(__dirname, "..", "scraper", "discover.js"));

const ROOT = path.join(__dirname, "..");
const OUT = path.join("logs", "getcourse-dump.html");

const LESSON_SCAN = /(?:\/pl)?\/teach\/control\/lesson\/view(?:\?id=|\/id\/)(\d+)/g;
const STREAM_SCAN = /(?:\/pl)?\/teach\/control\/stream\/view(?:\?id=|\/id\/)(\d+)/g;
const VIDEO_HINTS = [
  ["masterPlaylistUrl", /masterPlaylistUrl/g],
  ["data-master", /data-master=/g],
  ["vhi-root (плеер)", /vhi-root-/g],
  ["iframe", /<iframe/gi],
  ["youtube", /youtube\.com\/watch/g],
  ["api1.gcvh.ru", /api1\.gcvh\.ru/g],
];

function count(html, re) {
  return (html.match(re) || []).length;
}

function uniqueIds(html, re) {
  const ids = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Укажите адрес страницы: node cmd/dump.js <url или /path>");
    process.exit(1);
  }

  const base = (process.env.SCRAPPER_BASE_URL || "").replace(/\/$/, "");
  const target = discover.toPath(arg, base);
  if (!target) {
    console.error(`Адрес не с сайта ${base}`);
    process.exit(1);
  }

  const html = await fetch(base + target);
  await close();

  fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT), html);

  console.log(`\nСтраница: ${base + target}`);
  console.log(`Размер отрисованного HTML: ${html.length} символов`);
  console.log(`Сохранено: ${OUT}\n`);

  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  console.log(`Заголовок: ${title ? title[1].replace(/<[^>]+>/g, "").trim() : "—"}`);

  if (/Вход|Авторизация|login-form|name="email"/i.test(html) && html.length < 60000) {
    console.log("\n!! Похоже на страницу входа — сессия истекла. Войдите заново.");
  }

  const lessons = uniqueIds(html, LESSON_SCAN);
  const streams = uniqueIds(html, STREAM_SCAN);

  console.log(`\nУникальных уроков на странице:   ${lessons.length}`);
  if (lessons.length) console.log(`  id: ${lessons.slice(0, 15).join(", ")}${lessons.length > 15 ? " …" : ""}`);
  console.log(`Уникальных разделов/курсов:      ${streams.length}`);
  if (streams.length) console.log(`  id: ${streams.slice(0, 15).join(", ")}${streams.length > 15 ? " …" : ""}`);

  console.log("\nПризнаки видео:");
  for (const [name, re] of VIDEO_HINTS) {
    const n = count(html, re);
    console.log(`  ${name.padEnd(18)} ${n}`);
  }

  const anchors = count(html, /<a\s[^>]*href=/gi);
  console.log(`\nВсего ссылок <a href>: ${anchors}`);
})().catch(async (err) => {
  console.error(err.message || err);
  await close().catch(() => {});
  process.exit(1);
});
