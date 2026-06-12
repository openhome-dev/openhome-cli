import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../api/client.js";
import { getApiKey, getApiBase } from "../config/store.js";
import { error, success, info, p, handleCancel } from "../ui/format.js";
import chalk from "chalk";

function getEditor(): string {
  return process.env.VISUAL ?? process.env.EDITOR ?? "nano";
}

export async function agentsEditCommand(agentArg?: string): Promise<void> {
  p.intro("✏️  Edit agent prompt");

  const apiKey = getApiKey();
  if (!apiKey) {
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  const client = new ApiClient(apiKey, getApiBase());

  const s = p.spinner();
  s.start("Fetching agents...");
  let personalities: { id: string; name: string; description?: string }[];
  try {
    personalities = await client.getPersonalities();
    s.stop(`Found ${personalities.length} agent(s).`);
  } catch (err) {
    s.stop("Failed.");
    error(
      `Could not fetch agents: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (personalities.length === 0) {
    error("No agents found.");
    process.exit(1);
  }

  let agent: { id: string; name: string; description?: string };

  if (agentArg) {
    const match = personalities.find(
      (a) =>
        a.id === agentArg || a.name.toLowerCase() === agentArg.toLowerCase(),
    );
    if (!match) {
      error(`No agent found matching "${agentArg}".`);
      info(`Available: ${personalities.map((a) => a.name).join(", ")}`);
      process.exit(1);
    }
    agent = match;
  } else {
    const selected = await p.select({
      message: "Which agent do you want to edit?",
      options: personalities.map((a) => ({
        value: a.id,
        label: a.name,
        hint: `id: ${a.id}`,
      })),
    });
    handleCancel(selected);
    agent = personalities.find((a) => a.id === selected)!;
  }

  info(
    `Editing: ${chalk.bold(agent.name)}  ${chalk.gray(`(id: ${agent.id})`)}`,
  );

  const currentDescription = agent.description ?? "";

  // Write the agent prompt to a per-user private directory rather than
  // the world-readable /tmp on Linux. On most Linuxes /tmp is mode
  // 1777 and an attacker on the same box could read the file while
  // the editor session is open. We use mkdtemp under ~/.openhome/tmp
  // (parent dir 0o700) and chmod the file 0o600 — both unconditional,
  // not platform-dependent.
  const baseTmp = join(homedir(), ".openhome", "tmp");
  try {
    mkdirSync(baseTmp, { recursive: true, mode: 0o700 });
    // Tighten in case the dir existed with looser perms.
    chmodSync(baseTmp, 0o700);
  } catch {
    // mkdtemp() below will surface any fatal error.
  }

  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(baseTmp, "agent-edit-"));
  } catch {
    // Last-resort fallback to os.tmpdir() — we still set 0o600 on the
    // file so a co-resident attacker would need to win a tight race
    // and read the open file before chmod.
    tmpDir = tmpdir();
  }
  const tmpFile = join(tmpDir, `openhome-agent-${agent.id}-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, currentDescription, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tmpFile, 0o600);
  } catch {
    error("Could not write temp file for editing.");
    process.exit(1);
  }

  const editor = getEditor();
  info(`Opening in ${chalk.bold(editor)}... (save and close to apply changes)`);

  try {
    execFileSync(editor, [tmpFile], { stdio: "inherit" });
  } catch {
    // Editor exited non-zero (e.g. user quit without saving in some editors) — still read the file
  }

  let newDescription: string;
  try {
    newDescription = readFileSync(tmpFile, "utf8");
  } catch {
    error("Could not read temp file after editing.");
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  try {
    unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }

  if (newDescription === currentDescription) {
    p.outro("No changes made.");
    return;
  }

  const charDiff = newDescription.length - currentDescription.length;
  const diffLabel = charDiff >= 0 ? `+${charDiff}` : String(charDiff);
  info(`Prompt updated (${diffLabel} chars). Saving...`);

  const s2 = p.spinner();
  s2.start("Saving changes...");
  try {
    await client.updatePersonality(agent.id, agent.name, newDescription);
    s2.stop("Saved.");
    success(`Agent "${agent.name}" prompt updated.`);
  } catch (err) {
    s2.stop("Failed.");
    error(
      `Could not save: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  p.outro("Done.");
}
