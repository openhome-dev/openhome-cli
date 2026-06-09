import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getApiKey } from "../config/store.js";
import { error, success, info, p } from "../ui/format.js";
import chalk from "chalk";

const LOCAL_DIR = join(homedir(), ".openhome", "local");
const CLIENT_PATH = join(LOCAL_DIR, "local_client.py");
const PID_PATH = join(LOCAL_DIR, "local_client.pid");
const LOG_PATH = join(LOCAL_DIR, "local_client.log");
const CLIENT_DOWNLOAD_URL =
  "https://drive.google.com/file/d/12Is4eXchH5dDjlG39Knp4oRuD-V3D-v_/view?usp=drive_link";

export function getPidForMenu(): number | null {
  return getPid();
}

function getPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  if (Number.isNaN(pid)) return null;
  // Check if process is actually running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function localCommand(
  sub: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const apiKey = getApiKey() ?? "";
  if (!apiKey) {
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  switch (sub) {
    case "start": {
      const existing = getPid();
      if (existing) {
        info(`Local client already running (pid ${existing})`);
        info(`Logs: ${LOG_PATH}`);
        return;
      }

      const s = p.spinner();

      if (!existsSync(CLIENT_PATH)) {
        mkdirSync(LOCAL_DIR, { recursive: true });
        p.note(
          [
            `Download local_client.py from:`,
            chalk.cyan(CLIENT_DOWNLOAD_URL),
            ``,
            `Then save it to:`,
            chalk.bold(CLIENT_PATH),
            ``,
            `Once saved, run ${chalk.bold("openhome local start")} again.`,
          ].join("\n"),
          "Setup Required",
        );
        return;
      }

      // Verify python3 is available
      try {
        execFileSync("python3", ["--version"], { stdio: "ignore" });
      } catch {
        error("python3 not found. Install Python 3.7+ to use local abilities.");
        process.exit(1);
      }

      s.start("Starting local client...");
      const log = openSync(LOG_PATH, "a");
      const child = spawn("python3", [CLIENT_PATH], {
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.unref();
      writeFileSync(PID_PATH, String(child.pid));
      s.stop("Started.");

      success(`Local client running (pid ${child.pid})`);
      info(`Logs: ${chalk.gray(LOG_PATH)}`);
      info(`Stop with: ${chalk.bold("openhome local stop")}`);
      break;
    }

    case "stop": {
      const pid = getPid();
      if (!pid) {
        info("Local client is not running.");
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        writeFileSync(PID_PATH, "");
        success(`Stopped (pid ${pid})`);
      } catch (err) {
        error(
          `Failed to stop: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      break;
    }

    case "status": {
      const pid = getPid();
      if (pid) {
        success(`Running (pid ${pid})`);
        info(`Logs: ${chalk.gray(LOG_PATH)}`);
      } else {
        info("Not running. Start with: openhome local start");
      }
      break;
    }

    default:
      error(`Unknown subcommand "${sub}". Use: start | stop | status`);
      process.exit(1);
  }
}
