// Builds config/trainings/<SCRAPPER_TRAINING_CONFIG_DIR>/trainings.json by
// crawling your course pages, so you don't have to paste lesson ids by hand.
//
//   node cmd/discover.js                      # find courses automatically
//   node cmd/discover.js /teach/control/stream/view/id/123456
//   node cmd/discover.js https://site.ru/teach/control/stream/view/id/123456

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { close } = require(path.join(__dirname, "..", "scraper", "browser.js"));
const discover = require(path.join(__dirname, "..", "scraper", "discover.js"));

const log = (event) => event.line && console.log(event.line);

(async () => {
  const base = (process.env.SCRAPPER_BASE_URL || "").replace(/\/$/, "");
  const args = process.argv.slice(2);

  let streamPaths;

  if (args.length) {
    streamPaths = args.map((a) => discover.toPath(a, base)).filter(Boolean);
    if (streamPaths.length !== args.length) {
      console.error(`Some arguments are not paths on ${base}`);
      process.exit(1);
    }
  } else {
    streamPaths = await discover.findCourses(log);
    if (!streamPaths.length) {
      console.error(
        "\nНе нашёл ни одного курса. Откройте курс в браузере, скопируйте адрес\n" +
          "и передайте явно: node cmd/discover.js <url>\n" +
          "Если сайт требует входа — сначала: node cmd/login.js"
      );
      await close();
      process.exit(1);
    }
  }

  const trainings = await discover.findLessons(streamPaths, log);
  await close();

  const total = trainings.reduce((n, t) => n + t.paths.length, 0);
  if (!total) {
    console.error("Уроков не найдено. Сессия могла истечь — повторите: node cmd/login.js");
    process.exit(1);
  }

  const { file, backup } = discover.saveTrainings(trainings);
  if (backup) console.log(`\nПредыдущий конфиг сохранён как ${path.basename(backup)}`);
  console.log(`Записано: ${file}`);
  console.log(`Курсов: ${trainings.length}, уроков: ${total}`);
})().catch(async (err) => {
  console.error(err);
  await close().catch(() => {});
  process.exit(1);
});
