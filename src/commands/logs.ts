import { getApiKey, getConfig, getApiBase } from "../config/store.js";
import { ApiClient } from "../api/client.js";
import { error, success, info, p, handleCancel } from "../ui/format.js";
import { createAgentSocket } from "../ws/agent-socket.js";
import chalk from "chalk";
import WebSocket from "ws";
import * as readline from "node:readline";

export async function logsCommand(
  opts: { agent?: string; callLogs?: boolean } = {},
): Promise<void> {
  p.intro("📡 Stream agent logs");

  const apiKey = getApiKey();
  if (!apiKey) {
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  let agentId = opts.agent ?? getConfig().default_personality_id;

  if (!agentId) {
    const s = p.spinner();
    s.start("Fetching agents...");
    try {
      const client = new ApiClient(apiKey, getApiBase());
      const agents = await client.getPersonalities();
      s.stop(`Found ${agents.length} agent(s).`);

      if (agents.length === 0) {
        error("No agents found.");
        process.exit(1);
      }

      const selected = await p.select({
        message: "Which agent?",
        options: agents.map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.id,
        })),
      });
      handleCancel(selected);
      agentId = selected as string;
    } catch (err) {
      s.stop("Failed.");
      error(
        `Could not fetch agents: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  info(`Press ${chalk.bold("Ctrl+C")} or ${chalk.bold("Esc")} to stop.\n`);

  // ESC key exits
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  function cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
  }

  if (opts.callLogs) {
    // Call-level logs via dedicated WebSocket
    const base =
      getApiBase()?.replace("https://", "wss://").replace("http://", "ws://") ??
      "wss://app.openhome.com";
    const url = `${base}/websocket/logs?api_key=${apiKey}&tail=100`;
    info(`Streaming call logs...`);

    const ws = new WebSocket(url, {
      headers: {
        Origin: "https://app.openhome.com",
        "User-Agent": "openhome-cli",
      },
    });

    const done = new Promise<void>((resolve) => {
      ws.on("open", () => success("Connected to call logs. Waiting...\n"));
      ws.on("message", (raw) => {
        const ts = chalk.gray(new Date().toLocaleTimeString());
        try {
          const msg = JSON.parse(raw.toString());
          const role =
            msg.role === "assistant"
              ? chalk.cyan("AGENT")
              : chalk.green("USER");
          if (msg.content) console.log(`${ts} [${role}] ${msg.content}`);
          else console.log(`${ts} ${chalk.gray(JSON.stringify(msg))}`);
        } catch {
          console.log(`${ts} ${raw.toString()}`);
        }
      });
      ws.on("error", (err) => error(`WebSocket error: ${err.message}`));
      ws.on("close", (code) => {
        console.log("");
        info(`Disconnected (${code})`);
        resolve();
      });
    });

    const exitHandler = (_str: string, key: { name: string }) => {
      if (key?.name === "escape") {
        ws.close();
        cleanup();
      }
    };
    process.stdin.on("keypress", exitHandler);
    process.on("SIGINT", () => {
      console.log("");
      info("Stopping...");
      ws.close();
      cleanup();
    });

    await done;
    cleanup();
    return;
  }

  // Default: real-time agent message stream
  info(`Streaming messages from agent ${chalk.bold(agentId)}...`);

  const socket = createAgentSocket({
    apiKey,
    agentId,
    baseUrl: getApiBase()
      ?.replace("https://", "wss://")
      .replace("http://", "ws://"),

    onConnect() {
      success("Connected. Waiting for messages...\n");
    },

    onEvent(type, data) {
      const ts = chalk.gray(new Date().toLocaleTimeString());

      switch (type) {
        case "log":
          console.log(`${ts} ${chalk.blue("[LOG]")} ${JSON.stringify(data)}`);
          break;
        case "action":
          console.log(
            `${ts} ${chalk.magenta("[ACTION]")} ${JSON.stringify(data)}`,
          );
          break;
        case "progress":
          console.log(
            `${ts} ${chalk.yellow("[PROGRESS]")} ${JSON.stringify(data)}`,
          );
          break;
        case "question":
          console.log(
            `${ts} ${chalk.cyan("[QUESTION]")} ${JSON.stringify(data)}`,
          );
          break;
        case "message": {
          const d = data as { content?: string; role?: string; live?: boolean };
          if (d.content && !d.live) {
            const role =
              d.role === "assistant"
                ? chalk.cyan("AGENT")
                : chalk.green("USER");
            console.log(`${ts} ${chalk.white(`[${role}]`)} ${d.content}`);
          }
          break;
        }
        case "error-event": {
          const d = data as { message?: string; title?: string };
          console.log(
            `${ts} ${chalk.red("[ERROR]")} ${d?.message ?? d?.title ?? JSON.stringify(data)}`,
          );
          break;
        }
        default:
          console.log(
            `${ts} ${chalk.gray(`[${type}]`)} ${JSON.stringify(data)}`,
          );
      }
    },

    onError(err) {
      error(`WebSocket error: ${err.message}`);
    },
    onClose(code) {
      console.log("");
      info(`Connection closed (code: ${code})`);
    },
  });

  const exitHandler = (_str: string, key: { name: string }) => {
    if (key?.name === "escape") {
      info("Stopping log stream...");
      socket.close();
      cleanup();
    }
  };
  process.stdin.on("keypress", exitHandler);
  process.on("SIGINT", () => {
    console.log("");
    info("Stopping log stream...");
    socket.close();
    cleanup();
  });

  await socket.done;
  cleanup();
}
