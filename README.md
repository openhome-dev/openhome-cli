# OpenHome CLI

Command-line tool for managing OpenHome voice AI abilities. Deploy, test, and manage abilities without leaving your terminal — and let AI agents do it for you.

**Version:** v0.1.40
**Node:** 18+
**Platform:** macOS (primary), Linux/Windows (config-file fallback for keychain)

---

## Built for Humans and Agents

Every command in this CLI works **fully non-interactively**. That means Claude Code, Claude agents, GitHub Actions, and any other automated context can deploy abilities, assign them to agents, and test them via `openhome chat` — no browser, no prompts, no human in the loop.

```bash
# Auth (one-time — or use env vars in CI, no disk writes needed)
export OPENHOME_API_KEY=<your_api_key>
export OPENHOME_JWT=<your_session_token>

# Deploy, assign, and chat-test an ability — all scriptable
openhome deploy ./my-ability.zip --name "weather-bot" --category skill --triggers "weather" --json
openhome assign --agent "My Agent" --capabilities weather-bot --json
openhome chat <agent_id>
```

When called with no TTY (pipes, CI, agents), `openhome` with no arguments prints a machine-readable command reference and exits — so agents always get structured output.

**All commands support `--json`** for machine-readable output. **All prompts can be bypassed with flags.** Auth works via environment variables with no keychain access required.

---

## Community & Resources

| | |
| --- | --- |
| 🌐 **Website** | [openhome.com](https://openhome.com) |
| 📖 **Docs** | [docs.openhome.com](https://docs.openhome.com) |
| 🤖 **Dev Kit** | [dev.openhome.com](https://dev.openhome.com) — hardware waitlist, but you can build abilities today |
| 💬 **Discord** | [discord.gg/gPpSCmuxWW](https://discord.gg/gPpSCmuxWW) |
| 🐦 **X / Twitter** | [@openhome](https://x.com/openhome) |
| 🐙 **GitHub** | [github.com/openhome-dev](https://github.com/openhome-dev) |
| 📦 **Community Abilities** | [openhome-dev/abilities](https://github.com/openhome-dev/abilities/tree/dev/community) |

### Sharing Your Abilities

**Keep it private:** Deploy directly with `openhome deploy` — your code stays local, only the zip goes to OpenHome.

**Open-source it:** Submit a PR to [openhome-dev/abilities](https://github.com/openhome-dev/abilities/tree/dev/community) on the `dev` branch. See the [contribution guide](https://github.com/openhome-dev/abilities/blob/dev/CONTRIBUTING.md) for the folder structure and checklist. Community abilities show up in the OpenHome ability library for anyone to use.

---

## Install

```bash
# Use directly without installing
npx openhome-cli

# Or install globally
npm install -g openhome-cli
openhome
```

---

## Quick Start (Interactive)

```bash
# 1. Log in with your API key
openhome login

# 2. Zip your ability folder, then deploy
cd path/to/my-ability && zip -r ../my-ability.zip . && cd ..
openhome deploy ./my-ability.zip

# 3. Assign to an agent
openhome assign

# 4. Chat to test it
openhome chat
```

Or just run `openhome` with no arguments for the interactive menu.

---

## CI / Agent Usage

All commands work non-interactively when the required flags are supplied.

**Auth via environment variables (no disk writes, no keychain access):**

```bash
export OPENHOME_API_KEY=<your_api_key>
export OPENHOME_JWT=<your_session_token>
```

**Typical agent/CI workflow:**

```bash
# 0. Check auth state first — if jwt_status is expired/missing, stop and ask the human to run: openhome set-jwt
openhome whoami --json

# 1. Zip the ability (from parent directory)
zip -r my-skill.zip my-skill/

# 2. Deploy, list, assign, clean up
openhome deploy ./my-skill.zip --name "my-skill" --description "Does X" \
  --category skill --triggers "activate" --json
openhome list --json
openhome assign --agent "My Agent" --capabilities <id_from_list> --json
openhome delete <id> --yes --json
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error |
| `2` | Auth error (expired JWT, invalid key) |

---

## Commands

### `openhome` (no arguments)

Opens an interactive menu. Use arrow keys to navigate, Enter to select. The menu loops after each command.

If you are not logged in, the CLI prompts for login before showing the menu.

---

### `openhome login`

Authenticate with your OpenHome API key.

1. Prompts for your API key (masked input)
2. Verifies the key against the OpenHome API
3. Stores the key securely (macOS Keychain, or `~/.openhome/config.json` fallback)

```bash
openhome login

# Non-interactive (skips all prompts)
openhome login --key <API_KEY> --jwt <SESSION_TOKEN>
```

| Flag | What it does |
|------|-------------|
| `--key <api_key>` | API key (skips prompt) |
| `--jwt <token>` | Session token (skips browser setup step) |

---

### `openhome set-jwt [token]`

Save a session token to unlock management commands (`list`, `delete`, `assign`, `status`).

```bash
# Guided flow — opens browser and walks you through copying the token
openhome set-jwt

# Direct — paste the token
openhome set-jwt eyJ...
```

**Guided flow:** Opens `app.openhome.com`, then walks you through the browser console steps to copy your session token to clipboard.

The token is saved to macOS Keychain (or `~/.openhome/config.json` fallback). You only need to do this once (until your session expires).

---

### `openhome deploy [path]`

Validate and upload an ability zip to OpenHome.

> **You must zip your ability first.** The CLI does not auto-zip directories. Run `zip -r my-ability.zip my-ability/` from the parent directory before deploying.

```bash
# Deploy a zip from current directory (must already be zipped)
openhome deploy ./my-ability.zip

# Non-interactive
openhome deploy ./my-ability.zip \
  --name "Weather Bot" \
  --description "Checks the weather" \
  --category skill \
  --triggers "check weather,whats the weather"

# Attach to specific agent (use numeric agent ID from `openhome agents --json`)
openhome deploy ./my-ability.zip --personality <agent_id>
```

| Flag | What it does |
|------|-------------|
| `--name <name>` | Ability name (skips prompt) |
| `--description <desc>` | Description (skips prompt) |
| `--category <cat>` | `skill` \| `brain_skill` \| `background_daemon` \| `local` |
| `--triggers <words>` | Comma-separated trigger words (skips prompt) |
| `--personality <id>` | Override default agent for this deploy |
| `--timeout <seconds>` | Upload timeout (default: 120) |
| `--mock` | Use fake API responses for testing |
| `--json` | Machine-readable JSON output |

**What happens on deploy:**

1. Validates the zip contents (blocks if errors)
2. Asks for confirmation (skipped when non-interactive flags provided)
3. Uploads to OpenHome

> **Note:** There is no update/overwrite endpoint yet. Re-deploying with the same name will fail with a naming conflict. Delete the old version first with `openhome delete`.

---

### `openhome validate [path]`

Run validation checks on an ability directory without deploying. Same checks `deploy` runs internally.

```bash
# Validate current directory
openhome validate

# Validate specific directory
openhome validate ./my-ability
```

Prints all errors (which would block deploy) and warnings (which would not).

| Flag     | What it does                 |
|----------|------------------------------|
| `--json` | Machine-readable JSON output |

---

### `openhome list`

List all your deployed abilities.

```bash
openhome list
openhome list --json
openhome list --mock
```

Shows a table with name, version, status, and last update date.

Status colors: green = active, yellow = processing, red = failed, gray = disabled.

| Flag | What it does |
|------|-------------|
| `--json` | Machine-readable JSON output |
| `--mock` | Use fake API client |

---

### `openhome delete [ability]`

Delete a deployed ability.

```bash
# Interactive
openhome delete

# By name
openhome delete my-weather-bot

# Skip confirmation (useful for CI)
openhome delete my-weather-bot --yes
```

| Flag | What it does |
|------|-------------|
| `--yes` | Skip confirmation prompt |
| `--json` | Machine-readable JSON output |
| `--mock` | Use fake API client |

---

### `openhome assign`

Assign abilities to an agent.

```bash
# Interactive multiselect
openhome assign

# Non-interactive (IDs or names accepted)
openhome assign --agent "My Agent" --capabilities id1,id2
```

| Flag | What it does |
|------|-------------|
| `--agent <id\|name>` | Agent ID or name (skips prompt) |
| `--capabilities <ids>` | Comma-separated ability IDs or names (skips prompt) |
| `--json` | Machine-readable JSON output |
| `--mock` | Use fake API client |

---

### `openhome agents`

View your agents and set a default for deploys.

```bash
openhome agents
openhome agents --json
```

Shows all agents with names and IDs. Optionally set or change your default agent (used by `deploy` when `--personality` is not specified).

| Flag | What it does |
|------|-------------|
| `--json` | Machine-readable JSON output |
| `--mock` | Use fake API client |

#### `openhome agents edit [agent]`

Edit an agent's name and system prompt in `$EDITOR`.

```bash
# Interactive
openhome agents edit

# Specific agent by name or numeric ID (use `openhome agents --json` to find IDs)
openhome agents edit <agent_id>
```

Opens your `$VISUAL` or `$EDITOR` (falls back to `nano`) with the current prompt pre-loaded. Saves on exit.

---

### `openhome chat [agent]`

Chat with an agent via WebSocket. Send text messages and trigger abilities with keywords.

```bash
openhome chat
openhome chat <agent_id>
```

Commands inside chat: `/quit`, `/exit`, or `/q` to disconnect. Ctrl+C also works.

> **Note:** Audio responses are not playable in the terminal. Text responses display normally.

---

### `openhome trigger [phrase]`

Send a trigger phrase to fire an ability remotely.

```bash
openhome trigger "play aquaprime"
openhome trigger --agent <agent_id> "check weather"
```

---

### `openhome test [trigger]`

Send a trigger and assert on the resulting WebSocket frame stream. Returns a clean `PASS`/`FAIL` so it can drive a tight iteration loop on a deployed ability without touching voice hardware.

```bash
# Hit the deployed ability and assert on cap-routing, agent log lines, and the
# spoken response — fail fast in ~30s instead of waiting for a real voice cycle.
openhome test "any new tickets" \
  --expect-cap freshtemplate2 \
  --expect-log "STEP A0" \
  --expect-log "STEP D probe returned" \
  --expect-speak "Tickets:" \
  --reject-speak "couldn't generate" \
  --timeout 90000

# Machine-readable output for CI / agent harnesses
openhome test "any new tickets" --expect-cap my-skill --expect-speak "Tickets:" --json
```

| Flag | What it does |
|------|-------------|
| `--trigger <phrase>` | Trigger phrase (alternative to positional arg) |
| `--agent <id>` | Agent ID (uses default if not set) |
| `--expect-cap <name>` | Fail unless `chat_details:{name:...}` routes to this capability `unique_name` |
| `--expect-log <regex>` | Fail unless an `editor_logging_handler` line matches (repeatable) |
| `--expect-speak <regex>` | Fail unless a final assistant message matches (repeatable) |
| `--reject-speak <regex>` | Fail if a final assistant message matches (e.g. error phrases) (repeatable) |
| `--timeout <ms>` | Overall timeout (default 60000) |
| `--log-file <path>` | Write the full frame stream here (default `/tmp/openhome-test.log`) |
| `--quiet` | Only print PASS/FAIL line |
| `--json` | Machine-readable JSON output |
| `--proxy-pi <ssh-target>` | SSH `user@host` of your DevKit — required for end-to-end Local Ability tests (see below) |
| `--proxy-pi-cap-dir <path>` | Override the DevKit's `local_capabilities` directory (default `/home/openhome/openhome_devkit/local_capabilities`) |

**Exit codes:** `0` = all assertions met, `1` = one or more missed (or timeout), `2` = setup error (auth/regex/missing trigger).

**JSON shape:**
```json
{
  "ok": true,
  "pass": true,
  "reason": null,
  "elapsed_ms": 24310,
  "asserts": [
    { "kind": "cap",   "expression": "my-skill",         "met": true },
    { "kind": "log",   "expression": "STEP A0",          "met": true },
    { "kind": "speak", "expression": "Tickets:",         "met": true }
  ],
  "log_file": "/tmp/openhome-test.log",
  "agent": "578906",
  "trigger": "any new tickets"
}
```

> **Note:** `test` opens a new voice-stream WebSocket to the same agent. If a hardware client (e.g. the OpenHome DevKit) is currently connected, the cloud will close that session — bring the hardware back online after iterating.

#### Testing Local Abilities (`--proxy-pi`)

Local Abilities (`category: local`) split execution between `main.py` (sandboxed) and `devkit_functions.py` (runs on the DevKit hardware). When `main.py` calls `send_devkit_capability_action()`, the cloud emits a `devkit-capability` frame and waits for a `devkit-capability-result` ACK from the device.

The plain `openhome test` flow can't drive this round-trip on its own: opening a fresh voice-stream WS displaces the kiosk session, so the cloud routes the dispatch back to **us**, not the DevKit. The harness records the frame but has no way to invoke the function — the call times out at 8s with `output: null`.

`--proxy-pi <user@host>` makes the harness mirror what the DevKit's node-server does on receipt of the frame: SSH-exec `sudo python3 .../<capability_name>/devkit_functions.py <function_name> <args>` on the DevKit and reply with `devkit-capability-result`. The cloud sees a normal device round-trip; `main.py`'s `await send_devkit_capability_action(...)` resolves with the function's stdout.

```bash
openhome test "ticket pulse" \
  --proxy-pi openhome@192.168.1.42 \
  --expect-cap mylocalability \
  --expect-speak "Tickets:"
```

Requirements: passwordless SSH access to the DevKit (key-based auth — the harness runs `ssh -o BatchMode=yes`), and the ability synced to the DevKit (Live Editor → Advanced DevKit Controls → Sync Abilities, or manual SCP).

---

### `openhome status [ability]`

Show detailed info for one ability.

```bash
openhome status my-weather-bot
openhome status                      # reads name from local config.json
openhome status my-weather-bot --json
```

| Flag | What it does |
|------|-------------|
| `--json` | Machine-readable JSON output |
| `--mock` | Use fake API client |

---

### `openhome logs`

Stream live agent messages and logs.

```bash
openhome logs
openhome logs --agent pers_abc123
```

---

### `openhome whoami`

Show auth status, default agent, and tracked abilities.

```bash
openhome whoami
openhome whoami --json    # includes jwt_status: valid | expiring_soon | expired | missing
```

---

### `openhome config [path]`

Edit trigger words, description, or category in a local `config.json`.

```bash
openhome config
openhome config ./my-ability
```

---

### `openhome mcp`

Start the OpenHome MCP voice server for Claude Code integration.

```bash
openhome mcp
```

Launches the OpenHome voice server as an MCP (Model Context Protocol) server for use with Claude Code and other MCP-compatible tools.

---

### `openhome logout`

Clear stored credentials and log out.

```bash
openhome logout
```

Removes the API key from macOS Keychain and clears the default agent from config.

---

## Validation Rules

Deploy and `validate` both run these checks. Errors block deployment. Warnings do not.

### Required Files

Every ability must have:
- `main.py`
- `__init__.py`
- `config.json`
- `README.md`

### config.json

Must contain:
- `unique_name` — non-empty string
- `matching_hotwords` — array of strings

### main.py Required Patterns

| What | Why |
|------|-----|
| Class extending `MatchingCapability` | OpenHome ability base class |
| `call(self, ...)` method | Entry point OpenHome calls |
| `worker: AgentWorker = None` | Required field declaration |
| `capability_worker: CapabilityWorker = None` | Required field declaration |
| `resume_normal_flow()` call | Returns control to user after ability runs |
| `# {{register_capability}}` comment | Template marker used by OpenHome |

### Blocked Patterns (Errors)

| Pattern | Use Instead |
|---------|-------------|
| `print()` | `self.worker.editor_logging_handler` |
| `asyncio.sleep()` | `self.worker.session_tasks.sleep()` |
| `asyncio.create_task()` | `self.worker.session_tasks.create()` |
| `open()` | `capability_worker` file helpers |
| `exec()` / `eval()` | Not allowed |
| `pickle` / `dill` / `shelve` / `marshal` | Not allowed (security) |
| `assert` | Not allowed |
| `hashlib.md5()` | Not allowed |

### Blocked Imports (Errors)

| Import | Why |
|--------|-----|
| `redis` | Not available in sandbox |
| `from src.utils.db_handler` | Internal, not for abilities |
| `connection_manager` | Internal, not for abilities |
| `user_config` | Internal, not for abilities |

### Warnings (Do Not Block)

| Check | Message |
|-------|---------|
| Hardcoded API keys (`sk_...`, `key_...`) | Use `capability_worker.get_single_key()` instead |
| Multiple class definitions | Only one `MatchingCapability` class expected per ability |

---

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENHOME_API_KEY` | API key — takes precedence over stored credentials |
| `OPENHOME_JWT` | Session token — takes precedence over stored credentials |
| `OPENHOME_API_BASE` | Override API endpoint (enterprise / staging environments) |
| `OPENHOME_NO_UPDATE` | Set to `1` to disable the auto-update check |

### Storage Location

```
~/.openhome/
  config.json    # Settings, fallback credentials
```

On macOS, API key and session token are stored in the system Keychain (service: `openhome-cli`). The config file is a fallback for non-macOS platforms or when Keychain is unavailable.

### Config Fields

| Field | Purpose | Default |
|-------|---------|---------|
| `api_base_url` | Override API endpoint | `https://app.openhome.com` |
| `default_personality_id` | Default agent for deploys | (none) |
| `api_key` | Fallback key storage (prefer Keychain) | (none) |
| `jwt` | Fallback session token (prefer Keychain) | (none) |

### Auto-update

The CLI checks npm once per day for a newer version (result cached — no network call on every run).

- **npx**: new version re-executed transparently
- **Global install**: one-line notice printed, current version continues
- Set `OPENHOME_NO_UPDATE=1` to disable (useful in CI)

---

## What This Tool Does NOT Do

- **No local ability testing** — Abilities run on the OpenHome platform. Use "Start Live Test" in the web editor.
- **No ability editing** — Edit locally, then re-deploy.
- **No update/redeploy** — Deploy creates a new entry; use `openhome delete` to remove the old one first.
- **No Windows Keychain** — API key stored in plaintext config on non-macOS platforms.

---

## API Status

| Command | Endpoint | Auth | Status |
|---------|----------|------|--------|
| `login` | `POST /api/sdk/verify_apikey/` | API key | Live |
| `agents` | `POST /api/sdk/get_personalities/` | API key | Live |
| `chat` | WebSocket `/websocket/voice-stream/` | API key | Live |
| `test` | WebSocket `/websocket/voice-stream/` | API key | Live |
| `deploy` | `POST /api/capabilities/add-capability/` | API key | Live |
| `list` | `GET /api/capabilities/get-installed-capabilities/` | JWT | Live |
| `delete` | `POST /api/capabilities/delete-capability/` | JWT | Live |
| `assign` | `PUT /api/personalities/edit-personality/` | JWT | Live |

Commands marked **JWT** require `openhome set-jwt` first.

---

## Roadmap

- [ ] `openhome watch` — Auto-deploy on file changes
- [ ] `openhome update` — Re-deploy/overwrite an existing ability (pending server-side update endpoint)
- [ ] Cross-platform secure key storage (Windows Credential Manager, Linux Secret Service)
- [ ] Management commands without JWT (pending OpenHome API update)

---

## Development

```bash
npm install
npm run build      # Build
npm run dev        # Run without building
npm run lint       # Type check
npm run test       # Run tests
```

---

## Terminology

| Term | Meaning |
|------|---------|
| **Ability** | A Python plugin that adds a feature to an OpenHome agent |
| **Agent** | A voice AI personality that can have multiple abilities (called "personality" in the API) |
| **Trigger words** | Spoken phrases that activate an ability (called `matching_hotwords` in config.json) |
| **Skill** | An ability type that runs when the user triggers it |
| **Brain Skill** | An ability type that the agent triggers automatically |
| **Background Daemon** | An ability type that runs continuously from session start |
| **CapabilityWorker** | The runtime helper object for speaking, listening, file I/O, and secrets |
| **AgentWorker** | The runtime object for logging and session management |

---

## License

MIT
