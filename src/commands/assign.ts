import { ApiClient, NotImplementedError } from "../api/client.js";
import { handleIfSessionExpired } from "./handle-session-expired.js";
import { MockApiClient } from "../api/mock-client.js";
import { getApiKey, getApiBase, getJwt } from "../config/store.js";
import { NO_API_KEY_MSG } from "./auth-messages.js";
import {
  error,
  success,
  info,
  p,
  handleCancel,
  jsonOut,
  jsonError,
} from "../ui/format.js";
import chalk from "chalk";

export async function assignCommand(
  opts: {
    mock?: boolean;
    agent?: string;
    capabilities?: string;
    json?: boolean;
  } = {},
): Promise<void> {
  if (!opts.json) p.intro("🔗 Assign abilities to agent");

  let client: ApiClient | MockApiClient;

  if (opts.mock) {
    client = new MockApiClient();
  } else {
    const apiKey = getApiKey() ?? "";
    const jwt = getJwt() ?? undefined;
    if (!apiKey) {
      if (opts.json) jsonError("UNAUTHENTICATED", NO_API_KEY_MSG, 2);
      error("Not authenticated. Run: openhome login");
      process.exit(1);
    }
    client = new ApiClient(apiKey, getApiBase(), jwt);
  }

  const s = opts.json ? null : p.spinner();
  s?.start("Fetching agents and abilities...");

  let personalities: Awaited<ReturnType<typeof client.getPersonalities>>;
  let abilities: Awaited<ReturnType<typeof client.listAbilities>>["abilities"];

  try {
    [personalities, { abilities }] = await Promise.all([
      client.getPersonalities(),
      client.listAbilities(),
    ]);
    s?.stop(
      `Found ${personalities.length} agent(s), ${abilities.length} ability(s).`,
    );
  } catch (err) {
    s?.stop("Failed to fetch data.");
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) jsonError("ERROR", msg);
    error(msg);
    process.exit(1);
  }

  if (personalities.length === 0) {
    if (opts.json)
      jsonError(
        "NO_AGENTS",
        "No agents found. Create one at https://app.openhome.com",
      );
    p.outro("No agents found. Create one at https://app.openhome.com");
    return;
  }

  if (abilities.length === 0) {
    if (opts.json)
      jsonError("NO_ABILITIES", "No abilities found. Run: openhome deploy");
    p.outro("No abilities found. Run: openhome deploy");
    return;
  }

  let agentId: string;
  let agentName: string;
  let chosenIds: string[];

  if (opts.agent && opts.capabilities !== undefined) {
    // Non-interactive path
    const matchedAgent = personalities.find(
      (per) =>
        String(per.id) === opts.agent ||
        per.name.toLowerCase() === opts.agent!.toLowerCase(),
    );
    if (!matchedAgent) {
      const available = personalities
        .map((per) => `${per.name} (${per.id})`)
        .join(", ");
      if (opts.json)
        jsonError(
          "NOT_FOUND",
          `No agent found matching "${opts.agent}". Available: ${available}`,
        );
      error(`No agent found matching "${opts.agent}". Available: ${available}`);
      process.exit(1);
    }
    agentId = String(matchedAgent.id);
    agentName = matchedAgent.name;

    const rawCaps = opts.capabilities
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    chosenIds = [];
    for (const raw of rawCaps) {
      const match = abilities.find(
        (a) =>
          a.ability_id === raw ||
          a.unique_name.toLowerCase() === raw.toLowerCase(),
      );
      if (!match) {
        const available = abilities
          .map((a) => `${a.unique_name} (${a.ability_id})`)
          .join(", ");
        if (opts.json)
          jsonError(
            "NOT_FOUND",
            `No ability found matching "${raw}". Available: ${available}`,
          );
        error(`No ability found matching "${raw}". Available: ${available}`);
        process.exit(1);
      }
      chosenIds.push(match.ability_id);
    }
  } else {
    // Interactive path
    const selectedAgent = await p.select({
      message: "Which agent do you want to update?",
      options: personalities.map((per) => ({
        value: String(per.id),
        label: per.name,
        hint: chalk.gray(String(per.id)),
      })),
    });
    handleCancel(selectedAgent);
    agentId = selectedAgent as string;
    agentName =
      personalities.find((per) => String(per.id) === agentId)?.name ?? agentId;

    info(
      `Select abilities to assign to "${agentName}". Deselecting all unassigns everything.`,
    );

    const selectedIds = await p.multiselect({
      message: `Abilities for "${agentName}"`,
      options: abilities.map((a) => ({
        value: a.ability_id,
        label: a.unique_name,
        hint: `${a.status}  v${a.version}`,
      })),
      required: false,
    });
    handleCancel(selectedIds);
    chosenIds = selectedIds as string[];
  }

  const numericIds = chosenIds
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
  const capabilityIds =
    numericIds.length === chosenIds.length
      ? numericIds
      : (chosenIds as unknown as number[]);

  s?.start(`Assigning ${chosenIds.length} ability(s) to "${agentName}"...`);
  try {
    const result = await client.assignCapabilities(agentId, capabilityIds);

    // Enable agent_capability for all assigned skill abilities so keyword
    // routing works — new installs default to system_capability only
    try {
      const installed = await client.getInstalledCapabilities();
      const skillIds = new Set(
        abilities
          .filter(
            (a) =>
              chosenIds.includes(a.ability_id) &&
              (a as { category?: string }).category !== "background_daemon" &&
              (a as { category?: string }).category !== "local",
          )
          .map((a) => a.ability_id),
      );
      for (const cap of installed) {
        const match = abilities.find(
          (a) => a.unique_name === cap.name && skillIds.has(a.ability_id),
        );
        if (match && !cap.agent_capability) {
          await client.enableAgentCapability(
            cap.id,
            cap.name,
            cap.category,
            cap.trigger_words,
          );
        }
      }
    } catch {
      // Non-fatal — assign succeeded, agent_capability toggle is best-effort
    }

    s?.stop("Done.");

    if (opts.json) {
      jsonOut({
        ok: true,
        agent_id: agentId,
        agent_name: agentName,
        assigned: chosenIds,
        count: chosenIds.length,
        message:
          result.message ?? `Updated with ${chosenIds.length} ability(s).`,
      });
      return;
    }

    success(
      result.message ??
        `"${agentName}" updated with ${chosenIds.length} ability(s).`,
    );
    p.outro("Done.");
  } catch (err) {
    s?.stop("Failed.");

    if (err instanceof NotImplementedError) {
      if (opts.json)
        jsonError("NOT_IMPLEMENTED", "Assign endpoint not yet implemented.");
      p.note("Assign endpoint not yet implemented.", "API Not Available Yet");
      return;
    }

    if (await handleIfSessionExpired(err, opts)) return;
    const msg = `Assign failed: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.json) jsonError("ERROR", msg);
    error(msg);
    process.exit(1);
  }
}
