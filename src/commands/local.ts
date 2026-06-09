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
const CLIENT_URL =
  "https://raw.githubusercontent.com/openhome-dev/abilities/main/templates/Local/local_client.py";

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

async function downloadClient(apiKey: string): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const res = await fetch(CLIENT_URL);
  if (!res.ok)
    throw new Error(`Failed to download local client: ${res.status}`);
  let src = await res.text();
  // Inject API key
  src = src.replace(
    /OPENHOME_API_KEY\s*=\s*["'][^"']*["']/,
    `OPENHOME_API_KEY = "${apiKey}"`,
  );
  writeFileSync(CLIENT_PATH, src, { mode: 0o755 });
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
        s.start("Downloading local client...");
        try {
          await downloadClient(apiKey);
          s.stop("Downloaded.");
        } catch (err) {
          s.stop("Download failed.");
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
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
