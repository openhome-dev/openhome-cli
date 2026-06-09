import { resolve, basename } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../api/client.js";
import { getApiKey, getApiBase } from "../config/store.js";
import {
  error,
  success,
  p,
  handleCancel,
  jsonOut,
  jsonError,
} from "../ui/format.js";
import chalk from "chalk";

function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(2));
  return resolve(p);
}

function scanForZips(
  dir: string,
  depth = 0,
): { path: string; label: string }[] {
  const found: { path: string; label: string }[] = [];
  if (!existsSync(dir)) return found;
  const home = homedir();
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".zip")) {
        const shortDir = dir.startsWith(home)
          ? `~${dir.slice(home.length)}`
          : dir;
        found.push({ path: full, label: `${entry.name}  (${shortDir})` });
      } else if (
        entry.isDirectory() &&
        depth < 2 &&
        !entry.name.startsWith(".")
      ) {
        found.push(...scanForZips(full, depth + 1));
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
  return found;
}

export async function updateCommand(
  abilityArg?: string,
  opts: { zip?: string; message?: string; json?: boolean } = {},
): Promise<void> {
  if (!opts.json) p.intro("🔄 Update Ability");

  const apiKey = getApiKey() ?? "";
  if (!apiKey) {
    if (opts.json)
      jsonError("UNAUTHENTICATED", "Not authenticated. Run: openhome login", 2);
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  const client = new ApiClient(apiKey, getApiBase());

  const s = opts.json ? null : p.spinner();
  s?.start("Fetching abilities...");

  let abilities: Awaited<ReturnType<typeof client.listAbilities>>["abilities"];
  try {
    ({ abilities } = await client.listAbilities());
    s?.stop(`Found ${abilities.length} ability(s).`);
  } catch (err) {
    s?.stop("Failed.");
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) jsonError("ERROR", msg);
    error(msg);
    process.exit(1);
  }

  if (abilities.length === 0) {
    if (opts.json)
      jsonError("NO_ABILITIES", "No abilities found. Run: openhome deploy");
    p.outro("No abilities found. Run: openhome deploy");
    return;
  }

  // Resolve which ability to update
  let targetId: string;
  let targetName: string;

  if (abilityArg) {
    const match = abilities.find(
      (a) =>
        a.ability_id === abilityArg ||
        a.unique_name.toLowerCase() === abilityArg.toLowerCase(),
    );
    if (!match) {
      const available = abilities
        .map((a) => `${a.unique_name} (${a.ability_id})`)
        .join(", ");
      if (opts.json)
        jsonError(
          "NOT_FOUND",
          `No ability matching "${abilityArg}". Available: ${available}`,
        );
      error(`No ability matching "${abilityArg}". Available: ${available}`);
      process.exit(1);
    }
    targetId = match.ability_id;
    targetName = match.unique_name;
  } else {
    const selected = await p.select({
      message: "Which ability do you want to update?",
      options: abilities.map((a) => ({
        value: a.ability_id,
        label: a.unique_name,
        hint: `${chalk.gray(a.status)}  v${a.version}`,
      })),
    });
    handleCancel(selected);
    targetId = selected as string;
    targetName =
      abilities.find((a) => a.ability_id === targetId)?.unique_name ?? targetId;
  }

  // Resolve zip path
  let zipPath: string;
  if (opts.zip) {
    zipPath = expandPath(opts.zip);
    if (!existsSync(zipPath)) {
      if (opts.json) jsonError("NOT_FOUND", `File not found: ${opts.zip}`);
      error(`File not found: ${opts.zip}`);
      process.exit(1);
    }
  } else {
    const home = homedir();
    const foundZips = [
      process.cwd(),
      join(home, "Desktop"),
      join(home, "Downloads"),
      join(home, "Documents"),
    ].flatMap((d) => scanForZips(d));

    const seen = new Set<string>();
    const uniqueZips = foundZips.filter(
      (z) => !seen.has(z.path) && seen.add(z.path),
    );

    if (uniqueZips.length > 0) {
      const selected = await p.select({
        message: `Select new zip for "${targetName}"`,
        options: [
          ...uniqueZips.map((z) => ({ value: z.path, label: z.label })),
          {
            value: "__custom__",
            label: "Other...",
            hint: "Enter a path manually",
          },
        ],
      });
      handleCancel(selected);
      if (selected === "__custom__") {
        const input = await p.text({
          message: "Path to zip file",
          placeholder: "~/path/to/ability.zip",
          validate: (val) => {
            if (!val?.trim()) return "Path is required";
            if (!existsSync(expandPath(val.trim())))
              return `File not found: ${val.trim()}`;
          },
        });
        handleCancel(input);
        zipPath = expandPath((input as string).trim());
      } else {
        zipPath = selected as string;
      }
    } else {
      const input = await p.text({
        message: `Path to new zip for "${targetName}"`,
        placeholder: "~/Desktop/my-ability.zip",
        validate: (val) => {
          if (!val?.trim()) return "Path is required";
          if (!existsSync(expandPath(val.trim())))
            return `File not found: ${val.trim()}`;
        },
      });
      handleCancel(input);
      zipPath = expandPath((input as string).trim());
    }
  }

  const commitMessage =
    opts.message ?? `Updated via openhome CLI — ${basename(zipPath)}`;

  // Get the release_id for this ability
  s?.start("Resolving release...");
  let releaseId: string;
  try {
    const installed = await client.getInstalledCapabilityByCapability(targetId);
    const rid =
      installed.release_id ?? (installed.id ? String(installed.id) : undefined);
    if (!rid) {
      throw new Error(
        "No release_id in server response — ability may not be installed on an agent yet.",
      );
    }
    releaseId = rid;
    s?.stop("Release resolved.");
  } catch (err) {
    s?.stop("Failed to resolve release.");
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) jsonError("ERROR", msg);
    error(msg);
    process.exit(1);
  }

  // Upload new zip
  let zipBuffer: Buffer;
  try {
    zipBuffer = readFileSync(zipPath);
  } catch (err) {
    const msg = `Could not read zip: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.json) jsonError("READ_ERROR", msg);
    error(msg);
    process.exit(1);
  }

  s?.start(`Uploading new version of "${targetName}"...`);
  try {
    const result = await client.updateAbilityCode(
      releaseId,
      zipBuffer,
      commitMessage,
    );
    s?.stop("Done.");

    if (opts.json) {
      jsonOut({
        ok: true,
        ability_id: targetId,
        name: targetName,
        message: result.detail ?? result.message ?? "Updated successfully.",
      });
      return;
    }

    success(
      result.detail ??
        result.message ??
        `"${targetName}" updated successfully.`,
    );
    p.outro("Done. Your ability is running the new code.");
  } catch (err) {
    s?.stop("Update failed.");
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) jsonError("ERROR", msg);
    error(`Update failed: ${msg}`);
    process.exit(1);
  }
}
