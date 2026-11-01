// CLI entry point. The actual work lives in scraper/pipeline.js, which the web
// UI (ui/server.js) drives too.

require("dotenv").config({ path: __dirname + "/.env" });

const path = require("path");
const { run } = require(__dirname + "/scraper/pipeline.js");

const configDir = process.env.SCRAPPER_TRAINING_CONFIG_DIR;
if (!configDir) {
  console.error("SCRAPPER_TRAINING_CONFIG_DIR is not set in .env");
  process.exit(1);
}

const trainingsFile = path.join(__dirname, "config", "trainings", configDir, "trainings.json");

let trainings;
try {
  trainings = require(trainingsFile);
} catch {
  console.error(`No training config at ${trainingsFile}`);
  console.error('Run "node cmd/discover.js" to build it.');
  process.exit(1);
}

function log(event) {
  switch (event.type) {
    case "start":
      console.log(`${event.trainings} training(s), ${event.lessons} lesson(s)`);
      break;
    case "training-start":
      console.log(`\nTraining ${event.index + 1} from ${event.total}: "${event.title}"`);
      break;
    case "lesson-done":
      console.log(`  ${event.title} — ${event.videos} video(s)`);
      break;
    case "lesson-novideo":
      console.log(`  No video on ${event.url}`);
      break;
    case "lesson-retry":
      console.log(`  Retry ${event.attempt}/${event.max} for ${event.url}: ${event.error}`);
      break;
    case "lesson-error":
      console.log(`  Giving up on ${event.url}: ${event.error}`);
      break;
    case "download-start":
      console.log(`Download ${event.path}`);
      break;
    case "download-progress":
      if (event.percent % 25 === 0) {
        console.log(`  ${event.title} ${event.percent}%${event.speed ? " at " + event.speed : ""}`);
      }
      break;
    case "download-done":
      console.log(`Done ${event.path}`);
      break;
    case "download-error":
      console.log(`Failed ${event.path}: ${event.error}`);
      break;
    case "scraping-done":
      console.log(`\nScraping done, waiting for ${event.downloads} download(s)...`);
      break;
    case "done":
      console.log(event.stopped ? "Stopped." : "All downloads finished.");
      break;
    case "fatal":
      console.error(event.error);
      break;
  }
}

(async () => {
  const control = await run({ trainings, onEvent: log });

  const stop = () => {
    console.log("\nStopping...");
    control.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await control.finished;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
