import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import { loginCommand } from "./commands/login.js";
import { deployCommand } from "./commands/deploy.js";
import { deleteCommand } from "./commands/delete.js";
import { assignCommand } from "./commands/assign.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { agentsCommand } from "./commands/agents.js";
import { agentsEditCommand } from "./commands/agents-edit.js";
import { logoutCommand } from "./commands/logout.js";
import { chatCommand } from "./commands/chat.js";
import { triggerCommand } from "./commands/trigger.js";
import { whoamiCommand } from "./commands/whoami.js";
import { configEditCommand } from "./commands/config-edit.js";
import { logsCommand } from "./commands/logs.js";
import { setJwtCommand } from "./commands/set-jwt.js";
import { validateCommand } from "./commands/validate.js";
import { testCommand, collect } from "./commands/test.js";
import { p, handleCancel } from "./ui/format.js";
import { getConfig, saveConfig, getJwt, getJwtStatus } from "./config/store.js";
import chalk from "chalk";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let version = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version?: string };
  version = pkg.version ?? version;
} catch {
  // fallback to default
}

// ── Auto-update check ────────────────────────────────────────────
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // once per day

async function checkForUpdates(): Promise<void> {
  // Skip if disabled, re-execing, or in JSON mode (would corrupt piped output)
  if (process.env.OPENHOME_NO_UPDATE === "1") return;
  if (process.argv.includes("--json")) return;

  try {
    // Use cached result if checked within the last 24h
    const config = getConfig();
    const lastCheck = config.last_version_check ?? 0;
    const cached = config.latest_version_cache ?? null;
    const now = Date.now();

    let latest: string | undefined;

    if (now - lastCheck < UPDATE_CHECK_INTERVAL && cached) {
      latest = cached;
    } else {
      const res = await fetch(
        "https://registry.npmjs.org/openhome-cli/latest",
        { signal: AbortSignal.timeout(2000) },
      );
      const data = (await res.json()) as { version?: string };
      latest = data.version;
      if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
        config.last_version_check = now;
        config.latest_version_cache = latest;
        saveConfig(config);
      }
    }
    // Validate semver format before using — guards against poisoned registry responses
    if (!latest || latest === version) return;
    if (!/^\d+\.\d+\.\d+$/.test(latest)) return;

    // Only act if npm version is strictly newer
    const toNum = (v: string) =>
      v
        .split(".")
        .map(Number)
        .reduce((a, n) => a * 1000 + n, 0);
    if (toNum(latest) <= toNum(version)) return;

    // Detect npx: argv[1] contains _npx or npm_execpath points to npx
    const arg1 = process.argv[1] ?? "";
    const isNpx =
      arg1.includes("_npx") ||
      arg1.includes(".npm/") ||
      (process.env.npm_execpath ?? "").includes("npx");

    if (isNpx) {
      // Re-exec with latest — user gets the new version transparently
      const { execFileSync } = await import("node:child_process");
      execFileSync(
        "npx",
        [`openhome-cli@${latest}`, ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, OPENHOME_NO_UPDATE: "1" } },
      );
      process.exit(0);
    } else {
      // Global install — show one-line notice, don't block
      const { default: chalk } = await import("chalk");
      console.log(
        chalk.yellow(
          `  Update available: v${version} → v${latest}   Run: npm install -g openhome-cli@latest\n`,
        ),
      );
    }
  } catch {
    // Network timeout or error — continue silently
  }
}

// ── Interactive menu (bare `openhome` with no args) ──────────────

async function ensureLoggedIn(): Promise<void> {
  const { getApiKey } = await import("./config/store.js");
  const key = getApiKey();
  if (!key) {
    await loginCommand();
    console.log("");
  }
}

async function checkJwtExpiry(): Promise<void> {
  const jwt = getJwt();
  if (!jwt) return;
  const status = getJwtStatus(jwt);
  if (status === "expiring_soon") {
    p.note(
      [
        "Your session token expires soon. Refresh it now to avoid interruptions:",
        "  1. Finish any work in the OpenHome web app first",
        "  2. Go to app.openhome.com → browser console (Cmd+Option+J / F12)",
        "  3. Run: copy(localStorage.getItem('access_token'))",
        '  4. Choose "🔑 Refresh Token" from the menu below, or run: openhome set-jwt <token>',
      ].join("\n"),
      chalk.yellow("⚠  Session token expiring soon"),
    );
  } else if (status === "expired") {
    p.note(
      [
        "Your session token has expired. List, delete, assign, and status commands will fail.",
        "Refresh it now:",
        "  1. Finish any work in the OpenHome web app first",
        "  2. Go to app.openhome.com → browser console (Cmd+Option+J / F12)",
        "  3. Run: copy(localStorage.getItem('access_token'))",
        '  4. Choose "🔑 Refresh Token" from the menu below, or run: openhome set-jwt <token>',
        "",
        "JWT tokens expire roughly every 7 days and are also invalidated when you open the web app.",
      ].join("\n"),
      chalk.red("✗  Session token expired"),
    );
  }
}

async function interactiveMenu(): Promise<void> {
  p.intro(`🏠 OpenHome CLI v${version}`);

  // Login first if not authenticated
  await ensureLoggedIn();

  // Warn if JWT is expiring or expired
  await checkJwtExpiry();

  let running = true;
  while (running) {
    const choice = await p.select({
      message: "What would you like to do?",
      options: [
        {
          value: "deploy",
          label: "⬆️   Upload Ability",
          hint: "Upload a zip file to OpenHome",
        },
        {
          value: "list",
          label: "📋  My Abilities",
          hint: "List deployed abilities",
        },
        {
          value: "delete",
          label: "🗑️   Delete Ability",
          hint: "Remove a deployed ability",
        },
        {
          value: "assign",
          label: "🔗  Assign to Agent",
          hint: "Link abilities to an agent",
        },
        {
          value: "agents",
          label: "🤖  My Agents",
          hint: "View agents and set default",
        },
        {
          value: "chat",
          label: "💬  Chat",
          hint: "Talk to your agent",
        },
        {
          value: "logs",
          label: "📡  Logs",
          hint: "Stream live agent messages",
        },
        {
          value: "set-jwt",
          label: "🔑  Refresh Token",
          hint: "Update your session token (JWT)",
        },
        {
          value: "logout",
          label: "🔓  Log Out",
          hint: "Clear credentials and re-authenticate",
        },
        { value: "exit", label: "👋  Exit", hint: "Quit" },
      ],
    });
    handleCancel(choice);

    switch (choice) {
      case "deploy":
        await deployCommand();
        break;
      case "list":
        await listCommand();
        break;
      case "delete":
        await deleteCommand();
        break;
      case "assign":
        await assignCommand();
        break;
      case "agents":
        await agentsCommand();
        break;
      case "chat":
        await chatCommand();
        break;
      case "logs":
        await logsCommand();
        break;
      case "set-jwt":
        await setJwtCommand();
        break;
      case "logout":
        await logoutCommand();
        await ensureLoggedIn();
        break;
      case "exit":
        running = false;
        break;
    }

    if (running) {
      console.log(""); // spacing between commands
    }
  }

  p.outro("See you next time!");
}

// ── Commander subcommands (direct usage) ─────────────────────────

const program = new Command();

program
  .name("openhome")
  .description("OpenHome CLI — manage abilities from your terminal")
  .version(version, "-v, --version", "Output the current version");

program
  .command("login")
  .description("Authenticate with your OpenHome API key")
  .option("--key <api_key>", "API key (skips prompts)")
  .option("--jwt <token>", "Session token (skips browser step)")
  .action(async (opts: { key?: string; jwt?: string }) => {
    await loginCommand(opts);
  });

program
  .command("logout")
  .description("Log out and clear stored credentials")
  .action(async () => {
    await logoutCommand();
  });

program
  .command("deploy [path]")
  .description("Upload an ability zip to OpenHome")
  .option("--name <name>", "Ability name (skips prompt)")
  .option("--description <desc>", "Description (skips prompt)")
  .option(
    "--category <cat>",
    "Category: skill | brain_skill | background_daemon | local",
  )
  .option("--triggers <words>", "Comma-separated trigger words (skips prompt)")
  .option("--personality <id>", "Agent ID to attach the ability to")
  .option(
    "--timeout <seconds>",
    "Upload timeout in seconds (default: 120)",
    "120",
  )
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client (no real network calls)")
  .action(
    async (
      path: string | undefined,
      opts: {
        mock?: boolean;
        personality?: string;
        name?: string;
        description?: string;
        category?: string;
        triggers?: string;
        timeout?: string;
        json?: boolean;
      },
    ) => {
      await deployCommand(path, opts);
    },
  );

program
  .command("chat [agent]")
  .description("Chat with an agent via WebSocket")
  .action(async (agent?: string) => {
    await chatCommand(agent);
  });

program
  .command("trigger [phrase]")
  .description("Send a trigger phrase to fire an ability remotely")
  .option("--agent <id>", "Agent ID (uses default if not set)")
  .action(async (phrase?: string, opts?: { agent?: string }) => {
    await triggerCommand(phrase, opts);
  });

program
  .command("test [trigger]")
  .description("Send a trigger and assert on the resulting frame stream")
  .option("--trigger <phrase>", "Trigger phrase (alternative to positional arg)")
  .option("--agent <id>", "Agent ID (uses default if not set)")
  .option(
    "--expect-cap <name>",
    "Fail unless chat_details routes to this capability unique_name",
  )
  .option(
    "--expect-log <regex>",
    "Fail unless an editor_logging_handler line matches (repeatable)",
    collect,
    [],
  )
  .option(
    "--expect-speak <regex>",
    "Fail unless a final assistant message matches (repeatable)",
    collect,
    [],
  )
  .option(
    "--reject-speak <regex>",
    "Fail if a final assistant message matches (repeatable)",
    collect,
    [],
  )
  .option("--timeout <ms>", "Overall timeout in milliseconds", "60000")
  .option("--log-file <path>", "Frame log destination (default /tmp/openhome-test.log)")
  .option("--quiet", "Only print PASS/FAIL line")
  .option("--json", "Output machine-readable JSON")
  .option(
    "--proxy-pi <ssh-target>",
    "SSH user@host of your DevKit. Required for end-to-end tests of " +
      "Local Abilities — opening a fresh voice-stream WS displaces the " +
      "kiosk session, so the cloud routes devkit-capability dispatches " +
      "back to us; this flag exec-proxies them to your Pi via SSH.",
  )
  .option(
    "--proxy-pi-cap-dir <path>",
    "Override the DevKit's local_capabilities directory " +
      "(default /home/openhome/openhome_devkit/local_capabilities)",
  )
  .action(
    async (
      trigger: string | undefined,
      opts: {
        trigger?: string;
        agent?: string;
        expectCap?: string;
        expectLog?: string[];
        expectSpeak?: string[];
        rejectSpeak?: string[];
        timeout?: string;
        logFile?: string;
        quiet?: boolean;
        json?: boolean;
        proxyPi?: string;
        proxyPiCapDir?: string;
      },
    ) => {
      await testCommand(trigger, opts);
    },
  );

program
  .command("list")
  .description("List all deployed abilities")
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client")
  .action(async (opts: { mock?: boolean; json?: boolean }) => {
    await listCommand(opts);
  });

program
  .command("delete [ability]")
  .description("Delete a deployed ability")
  .option("--yes", "Skip confirmation prompt")
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client")
  .action(
    async (
      ability: string | undefined,
      opts: { mock?: boolean; yes?: boolean; json?: boolean },
    ) => {
      await deleteCommand(ability, opts);
    },
  );

program
  .command("assign")
  .description("Assign abilities to an agent")
  .option("--agent <id>", "Agent ID or name (skips prompt)")
  .option(
    "--capabilities <ids>",
    "Comma-separated ability IDs or names (skips prompt)",
  )
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client")
  .action(
    async (opts: {
      mock?: boolean;
      agent?: string;
      capabilities?: string;
      json?: boolean;
    }) => {
      await assignCommand(opts);
    },
  );

const agentsCmd = program
  .command("agents")
  .description("View your agents and set a default")
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client")
  .action(async (opts: { mock?: boolean; json?: boolean }) => {
    await agentsCommand(opts);
  });

agentsCmd
  .command("edit [agent]")
  .description("Edit an agent's name and prompt in $EDITOR")
  .action(async (agent?: string) => {
    await agentsEditCommand(agent);
  });

program
  .command("status [ability]")
  .description("Show detailed status of an ability")
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use mock API client")
  .action(
    async (
      ability: string | undefined,
      opts: { mock?: boolean; json?: boolean },
    ) => {
      await statusCommand(ability, opts);
    },
  );

program
  .command("config [path]")
  .description("Edit trigger words, description, or category in config.json")
  .action(async (path?: string) => {
    await configEditCommand(path);
  });

program
  .command("validate [path]")
  .description("Validate an ability directory before deploying")
  .option("--json", "Output machine-readable JSON")
  .action(async (path: string | undefined, opts: { json?: boolean }) => {
    await validateCommand(path, opts);
  });

program
  .command("logs")
  .description("Stream live agent messages and logs")
  .option("--agent <id>", "Agent ID (uses default if not set)")
  .action(async (opts: { agent?: string }) => {
    await logsCommand(opts);
  });

program
  .command("whoami")
  .description("Show auth status, default agent, and tracked abilities")
  .option("--json", "Output machine-readable JSON")
  .action(async (opts: { json?: boolean }) => {
    await whoamiCommand(opts);
  });

program
  .command("set-jwt [token]")
  .description(
    "Save a session JWT token (required for list, delete, assign, status)",
  )
  .action(async (token?: string) => {
    await setJwtCommand(token);
  });

program
  .command("mcp")
  .description(
    "Start the OpenHome MCP voice server for Claude Code integration",
  )
  .action(async () => {
    // Launch voice-server directly in-process
    await import("./mcp/voice-server.js");
  });

// ── Entry point: menu if no args, subcommand otherwise ───────────

checkForUpdates().then(() => {
  if (process.argv.length <= 2) {
    // No TTY (agent/pipe context) → print machine-readable reference instead of
    // crashing into @clack/prompts which requires an interactive terminal
    if (!process.stdout.isTTY) {
      console.log(`# OpenHome CLI — Agent Reference v${version}

OpenHome deploys Python "abilities" to AI voice agents. This CLI is fully non-interactive
and designed for use by AI agents (Claude Code, GitHub Actions, etc) as well as humans.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## CRITICAL: JWT REQUIRES A HUMAN — READ THIS FIRST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

There are two credentials. Their automation properties are completely different:

  OPENHOME_API_KEY  — Fully automatable. Set it once, never expires, agents handle it.
  OPENHOME_JWT      — REQUIRES A HUMAN. Browser-only refresh. Agents cannot do this.

JWT tokens are invalidated immediately when the user opens the OpenHome web app
(the browser gets a new token and the old one dies). This is not a bug.

WHEN JWT IS EXPIRED (exit code 2 / SESSION_EXPIRED):
  → DO NOT retry. It will not work.
  → DO NOT attempt to refresh it yourself. You cannot.
  → STOP and tell the human exactly this:

    "Your OpenHome session token has expired. Please refresh it:
     Option A (interactive): run \`openhome\` and choose 'Refresh Token'
     Option B (direct):      run \`openhome set-jwt\` in your terminal
     Then retry this task."

BEFORE running any JWT-required command, check first:
  openhome whoami --json
  → jwt_status: "valid" = proceed
  → jwt_status: "expiring_soon" = warn the human, proceed
  → jwt_status: "expired" | "missing" = STOP, ask human to refresh

Commands that need JWT:  list, delete, assign, status
Commands that need only API key:  deploy, agents, chat, trigger, logs, validate, whoami

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Auth Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Option A — Environment variables (stateless, no disk writes, best for CI/agents):
  export OPENHOME_API_KEY=<your_api_key>
  export OPENHOME_JWT=<your_session_token>

Option B — Persistent login (run once by a human, creds saved to Keychain):
  openhome login --key <API_KEY> --jwt <SESSION_TOKEN>
  openhome whoami   # verify

Where to get credentials (human must do this in a browser):
  API_KEY → app.openhome.com/dashboard/settings → API Keys
  JWT     → open app.openhome.com, then browser console:
            copy(localStorage.getItem('access_token'))
  Tip: grab JWT after you are done in the web app — opening it invalidates the old token.

Env vars take precedence over stored credentials.
OPENHOME_NO_UPDATE=1 disables the auto-update check (useful in CI).
OPENHOME_API_BASE overrides the API endpoint (enterprise/staging).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Commands
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All commands support --json for machine-readable output.
All prompts can be bypassed with flags — no TTY required.

── Pre-flight ──────────────────────────────────────────────────────

whoami   Check auth state before doing anything else
  openhome whoami --json
  → ok, api_key_status, jwt_status (valid|expiring_soon|expired|missing),
    default_agent, tracked_abilities

validate  Check an ability for errors before deploying (no upload)
  openhome validate [path] [--json]
  → ok (bool), errors (block deploy), warnings (do not block)
  → exit 1 if errors, exit 0 if clean or warnings-only

── Ability lifecycle ───────────────────────────────────────────────

deploy   Upload an ability zip  [API key only]
  openhome deploy <path.zip> --name "Name" --description "Desc" \\
    --category skill --triggers "word1,word2" [--timeout 120] [--json]
  categories: skill | brain_skill | background_daemon | local
  NOTE: deploy requires a pre-made .zip file — it does NOT auto-zip a directory.
  To create the zip (must be from the PARENT directory, not from inside the folder):
    cd /path/to/parent && zip -r my-ability.zip my-ability/
    openhome deploy ./my-ability.zip --name "my-ability" ...
  NOTE: no overwrite endpoint exists yet — delete old version first if renaming

list     Show all uploaded abilities  [JWT required]
  openhome list [--json]
  → returns id (numeric string e.g. "3501"), name, display_name, status,
    version, category, trigger_words (array), updated_at

status   Detailed info for one ability  [JWT required]
  openhome status <id|name> [--json]

delete   Delete by ID or name  [JWT required]
  openhome delete <id|name> --yes [--json]
  --yes skips confirmation prompt (required for non-interactive use)

── Agent management ────────────────────────────────────────────────

agents   List agents and set default  [API key only]
  openhome agents [--json]
  → returns id (numeric string e.g. "123456"), name. Use name or id interchangeably.

assign   Link abilities to an agent  [JWT required]
  openhome assign --agent <agent_id|name> --capabilities <id1,id2,...> [--json]

── Testing ─────────────────────────────────────────────────────────

chat     WebSocket chat with an agent  [API key only]
  openhome chat [agent_id]
  → connects via WebSocket, send text to trigger abilities and see responses
  → type /quit or press Ctrl+C to disconnect
  → audio responses are not playable in terminal; text responses display normally
  → use this to verify an ability responds correctly after deploying

trigger  Fire a trigger phrase remotely  [API key only]
  openhome trigger "phrase" --agent <agent_id>

test     Send a trigger and assert on response frames  [API key only]
  openhome test "any new tickets" --agent <agent_id> \\
    --expect-cap my-skill --expect-log "STEP A0" --expect-speak "Tickets:" --json
  → returns ok, pass, asserts (per-expectation met state), elapsed_ms
  → exit 0 = all assertions met, 1 = at least one missed/timeout
  → use this for fast iteration without voice/hardware

logs     Stream live agent messages  [API key only]
  openhome logs [--agent <agent_id>]

── Auth management (human-only operations) ─────────────────────────

set-jwt  Update session token — REQUIRES HUMAN (browser action)  [no auth needed]
  openhome set-jwt <token>
  Agents: do not call this — you cannot supply the token. Tell the human to run it.

login    First-time auth setup — REQUIRES HUMAN (API key + JWT from browser)
  openhome login --key <API_KEY> --jwt <JWT_TOKEN>

logout   Clear all stored credentials
  openhome logout

── Integration ─────────────────────────────────────────────────────

mcp      Start OpenHome MCP voice server for Claude Code integration
  openhome mcp

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Typical agent workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # 1. Check auth state before starting
  openhome whoami --json
  # If jwt_status is expired/missing → STOP, ask human to run: openhome set-jwt

  # 2. Get your agent ID/name
  openhome agents --json
  # → pick an id or name from the returned list for use in assign/deploy

  # 3. Validate before deploying
  openhome validate ./my-ability

  # 4. Zip the ability (from parent directory — required)
  cd /path/to/parent && zip -r my-ability.zip my-ability/

  # 5. Deploy
  openhome deploy ./my-ability.zip --name "my-skill" --description "Does X" \\
    --category skill --triggers "activate" --json

  # 6. Assign to agent (use id or name from step 2)
  openhome assign --agent "My Agent" --capabilities my-skill --json

  # 7. Test via chat
  openhome chat <agent_id>

  # 8. Clean up old version if needed
  openhome delete <old_id> --yes --json

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Exit codes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  0 = success
  1 = error (bad input, network failure, etc — check stderr)
  2 = auth error (expired JWT, invalid API key) — STOP, needs human intervention

On exit code 2, the JSON error response includes:
  { "ok": false, "error": { "code": "SESSION_EXPIRED" | "AUTH_ERROR", "message": "..." } }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Notes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Ability IDs are numeric (e.g. 3501); names also accepted everywhere
- Agent IDs are numeric strings (e.g. "123456"); names also work in --agent flags
- JWT stored in macOS Keychain — survives reboots, no re-login each session
- agents edit command opens \\$EDITOR — interactive only, requires a human`);
      process.exit(0);
    }
    interactiveMenu().catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  } else {
    program.parseAsync(process.argv).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  }
});
