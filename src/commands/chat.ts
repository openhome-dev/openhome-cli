import { getApiKey, getConfig, getApiBase } from "../config/store.js";
import { ApiClient } from "../api/client.js";
import { error, success, info, p, handleCancel } from "../ui/format.js";
import { createAgentSocket } from "../ws/agent-socket.js";
import chalk from "chalk";
import * as readline from "node:readline";

export async function chatCommand(
  agentArg?: string,
  opts: { mock?: boolean } = {},
): Promise<void> {
  p.intro("💬 Chat with your agent");

  const apiKey = getApiKey();
  if (!apiKey) {
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  let agentId = agentArg ?? getConfig().default_personality_id;
  let agentName: string | null = null;

  const client = new ApiClient(apiKey, getApiBase());

  const s = p.spinner();
  s.start("Fetching agents...");
  let agents: { id: string; name: string }[] = [];
  try {
    agents = await client.getPersonalities();
    s.stop(`Found ${agents.length} agent(s).`);
  } catch (err) {
    s.stop("Could not fetch agent list.");
    if (!agentId) {
      error(
        `Could not fetch agents: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    // If we already have an agentId, continue without name
  }

  if (!agentId) {
    if (agents.length === 0) {
      error("No agents found. Create one at https://app.openhome.com");
      process.exit(1);
    }

    const selected = await p.select({
      message: "Which agent do you want to chat with?",
      options: agents.map((a) => ({
        value: a.id,
        label: a.name,
        hint: a.id,
      })),
    });
    handleCancel(selected);
    agentId = selected as string;
  }

  agentName = agents.find((a) => a.id === agentId)?.name ?? null;

  info(`Connecting to ${chalk.bold(agentName ?? agentId)}...`);

  let currentResponse = "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ESC key exits chat
  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdin.on("keypress", (_str, key) => {
    if (key?.name === "escape") {
      info("Closing connection...");
      socket.close();
      rl.close();
    }
  });

  const socket = createAgentSocket({
    apiKey,
    agentId,
    baseUrl: getApiBase()
      ?.replace("https://", "wss://")
      .replace("http://", "ws://"),

    onConnect() {
      success("Connected! Type a message and press Enter. Type /quit to exit.");
      console.log(
        chalk.gray(
          "  Tip: Send trigger words to activate abilities (e.g. 'play aquaprime')",
        ),
      );
      console.log("");
      promptUser();
    },

    onTextMessage(content, role, { live, final }) {
      if (role !== "assistant") return;

      const label = chalk.cyan(`${agentName ?? "Agent"}:`);

      if (live && !final) {
        // OpenHome sends full accumulated text each time — overwrite the line.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`${label} ${content}`);
        currentResponse = content;
      } else {
        if (currentResponse !== "") {
          console.log(""); // end the streamed line
        } else {
          console.log(`${label} ${content}`);
        }
        currentResponse = "";
        console.log("");
      }
    },

    onEvent(type) {
      if (type === "interrupt" && currentResponse !== "") {
        console.log("");
        currentResponse = "";
      }
      if (type === "text") {
        // audio-end with no streamed text — note it
        if (currentResponse === "") {
          // handled inline via onTextMessage; nothing extra needed
        }
      }
    },

    onError(err) {
      console.error("");
      error(`Server error: ${err.message}`);
    },

    onClose(code) {
      console.log("");
      if (code === 1000) {
        info("Disconnected.");
      } else {
        info(`Connection closed (code: ${code})`);
      }
      rl.close();
    },
  });

  function promptUser(): void {
    rl.question(chalk.green("You: "), (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        promptUser();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        info("Closing connection...");
        socket.close();
        rl.close();
        return;
      }

      socket.send("transcribed", trimmed);
      promptUser();
    });
  }

  rl.on("close", () => socket.close());

  await socket.done;
}
