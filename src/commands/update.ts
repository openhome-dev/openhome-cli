import { resolve, basename } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
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

function expandPath(input: string): string {
  if (input.startsWith("~/") || input === "~")
    return join(homedir(), input.slice(2));
  return resolve(input);
}

function isAbilityDir(dir: string): boolean {
  return existsSync(join(dir, "main.py"));
}

/** Scan for .zip files and ability directories (contain main.py). */
function scanForSources(
  dir: string,
  depth = 0,
): { path: string; label: string; isDir: boolean }[] {
  const found: { path: string; label: string; isDir: boolean }[] = [];
  if (!existsSync(dir)) return found;
  const home = homedir();
  const shortDir = (d: string) =>
    d.startsWith(home) ? `~${d.slice(home.length)}` : d;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".zip")) {
        found.push({
          path: full,
          label: `📦 ${entry.name}  (${shortDir(dir)})`,
          isDir: false,
        });
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        if (isAbilityDir(full)) {
          found.push({
            path: full,
            label: `📁 ${entry.name}/  (${shortDir(dir)})`,
            isDir: true,
          });
        } else if (depth < 2) {
          found.push(...scanForSources(full, depth + 1));
        }
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
  return found;
}

/** Create a flat zip from a directory (files at root, no top-level folder). */
function zipDirectory(dirPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `openhome-update-${Date.now()}.zip`);
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => {
      try {
        resolve(readFileSync(outPath));
      } catch (err) {
        reject(err);
      }
    });
    archive.on("error", reject);
    archive.pipe(output);

    // Add each file directly at root — no top-level directory
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isFile()) {
        archive.file(full, { name: entry.name });
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        archive.directory(full, entry.name);
      }
    }

    archive.finalize();
  });
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
  let targetReleaseId: string | undefined;

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
    targetReleaseId = match.release_id;
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
    const found = abilities.find((a) => a.ability_id === targetId);
    targetName = found?.unique_name ?? targetId;
    targetReleaseId = found?.release_id;
  }

  // Resolve source (zip file or ability directory)
  let sourcePath: string;
  let sourceIsDir = false;

  if (opts.zip) {
    sourcePath = expandPath(opts.zip);
    if (!existsSync(sourcePath)) {
      if (opts.json) jsonError("NOT_FOUND", `File not found: ${opts.zip}`);
      error(`File not found: ${opts.zip}`);
      process.exit(1);
    }
    sourceIsDir = statSync(sourcePath).isDirectory();
  } else {
    const home = homedir();
    const found = [
      process.cwd(),
      join(home, "Desktop"),
      join(home, "Downloads"),
      join(home, "Documents"),
    ]
      .flatMap((d) => scanForSources(d))
      .filter((z, i, arr) => arr.findIndex((x) => x.path === z.path) === i);

    if (found.length > 0) {
      const sel = await p.select({
        message: `Select source for "${targetName}"`,
        options: [
          ...found.map((z) => ({ value: z.path, label: z.label })),
          {
            value: "__custom__",
            label: "Other...",
            hint: "Enter a path manually",
          },
        ],
      });
      handleCancel(sel);
      if (sel === "__custom__") {
        const input = await p.text({
          message: "Path to zip file or ability directory",
          placeholder: "~/Desktop/my-ability.zip",
          validate: (val) => {
            if (!val?.trim()) return "Path is required";
            if (!existsSync(expandPath(val.trim())))
              return `Not found: ${val.trim()}`;
          },
        });
        handleCancel(input);
        sourcePath = expandPath((input as string).trim());
        sourceIsDir = statSync(sourcePath).isDirectory();
      } else {
        sourcePath = sel as string;
        sourceIsDir = found.find((z) => z.path === sourcePath)?.isDir ?? false;
      }
    } else {
      const input = await p.text({
        message: `Path to zip or directory for "${targetName}"`,
        placeholder: "~/Desktop/my-ability.zip",
        validate: (val) => {
          if (!val?.trim()) return "Path is required";
          if (!existsSync(expandPath(val.trim())))
            return `Not found: ${val.trim()}`;
        },
      });
      handleCancel(input);
      sourcePath = expandPath((input as string).trim());
      sourceIsDir = statSync(sourcePath).isDirectory();
    }
  }

  const commitMessage =
    opts.message ?? `Updated via openhome CLI — ${basename(sourcePath)}`;

  // Get the release_id for this ability
  if (!targetReleaseId) {
    if (opts.json)
      jsonError(
        "NO_RELEASE",
        "No release version found for this ability. Try redeploying with: openhome deploy",
      );
    error(
      "No release version found for this ability. Try redeploying with: openhome deploy",
    );
    process.exit(1);
  }
  const releaseId = targetReleaseId;

  // Build zip buffer
  let zipBuffer: Buffer;
  if (sourceIsDir) {
    s?.start(`Zipping ${basename(sourcePath)}/...`);
    try {
      zipBuffer = await zipDirectory(sourcePath);
      s?.stop("Zipped.");
    } catch (err) {
      s?.stop("Zip failed.");
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) jsonError("ZIP_ERROR", msg);
      error(`Failed to zip directory: ${msg}`);
      process.exit(1);
    }
  } else {
    try {
      zipBuffer = readFileSync(sourcePath);
    } catch (err) {
      const msg = `Could not read zip: ${err instanceof Error ? err.message : String(err)}`;
      if (opts.json) jsonError("READ_ERROR", msg);
      error(msg);
      process.exit(1);
    }
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
    p.outro("Done. Your ability is running the new code. 🎱");
  } catch (err) {
    s?.stop("Update failed.");
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) jsonError("ERROR", msg);
    error(`Update failed: ${msg}`);
    process.exit(1);
  }
}
