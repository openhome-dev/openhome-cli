import { getApiKey, getConfig, getApiBase } from "../config/store.js";
import { ApiClient } from "../api/client.js";
import {
  error,
  info,
  p,
  handleCancel,
  jsonOut,
  jsonError,
} from "../ui/format.js";
import { createAgentSocket } from "../ws/agent-socket.js";
import chalk from "chalk";

const RESPONSE_TIMEOUT = 30_000;

export async function triggerCommand(
  phraseArg?: string,
  opts: { agent?: string; json?: boolean } = {},
): Promise<void> {
  if (!opts.json) p.intro("⚡ Trigger an ability");

  const apiKey = getApiKey();
  if (!apiKey) {
    if (opts.json)
      jsonError("UNAUTHENTICATED", "Not authenticated. Run: openhome login", 2);
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  let phrase = phraseArg;
  if (!phrase) {
    if (opts.json) {
      jsonError(
        "MISSING_PHRASE",
        "Phrase required when using --json. Pass it as an argument.",
      );
      process.exit(1);
    }
    const input = await p.text({
      message: "Trigger phrase (e.g. 'play aquaprime')",
      validate: (val) => {
        if (!val?.trim()) return "A trigger phrase is required";
      },
    });
    handleCancel(input);
    phrase = (input as string).trim();
  }

  let agentId = opts.agent ?? getConfig().default_personality_id;

  if (!agentId) {
    if (opts.json) {
      jsonError(
        "NO_AGENT",
        "No default agent set. Use --agent <id> or run: openhome agents",
      );
      process.exit(1);
    }
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

  if (!opts.json)
    info(`Sending "${chalk.bold(phrase)}" to agent ${chalk.bold(agentId)}...`);

  const s = opts.json ? null : p.spinner();
  s?.start("Waiting for response...");

  let fullResponse = "";
  let responseTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const socket = createAgentSocket({
    apiKey,
    agentId,
    baseUrl: getApiBase()
      ?.replace("https://", "wss://")
      .replace("http://", "ws://"),

    onConnect() {
      socket.send("transcribed", phrase);

      responseTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          s?.stop(fullResponse ? "Response received." : "Timed out.");
          if (opts.json) {
            if (fullResponse)
              jsonOut({
                ok: true,
                agent_id: agentId,
                phrase,
                response: fullResponse,
              });
            else jsonError("TIMEOUT", "No response within 30s");
          } else if (fullResponse) {
            console.log(`\n${chalk.cyan("Agent:")} ${fullResponse}\n`);
          }
          socket.close();
        }
      }, RESPONSE_TIMEOUT);
    },

    onTextMessage(content, role, { live, final }) {
      if (role !== "assistant") return;

      if (!live || final) {
        if (!settled) {
          settled = true;
          if (responseTimer) clearTimeout(responseTimer);
          fullResponse = content;
          s?.stop("Response received.");
          if (opts.json)
            jsonOut({
              ok: true,
              agent_id: agentId,
              phrase,
              response: fullResponse,
            });
          else console.log(`\n${chalk.cyan("Agent:")} ${fullResponse}\n`);
          socket.close();
        }
      } else {
        fullResponse = content;
      }
    },

    onEvent(type) {
      if (type === "text" && fullResponse && !settled) {
        settled = true;
        if (responseTimer) clearTimeout(responseTimer);
        s?.stop("Response received.");
        if (opts.json)
          jsonOut({
            ok: true,
            agent_id: agentId,
            phrase,
            response: fullResponse,
          });
        else console.log(`\n${chalk.cyan("Agent:")} ${fullResponse}\n`);
        socket.close();
      }
    },

    onError(err) {
      if (!settled) {
        settled = true;
        if (responseTimer) clearTimeout(responseTimer);
        s?.stop("Error.");
        if (opts.json) jsonError("ERROR", err.message);
        else error(err.message);
        socket.close();
      }
    },

    onClose() {
      if (responseTimer) clearTimeout(responseTimer);
    },
  });

  await socket.done;
}
