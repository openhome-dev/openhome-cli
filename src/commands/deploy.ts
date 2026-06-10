import { resolve, join, basename } from "node:path";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import archiver from "archiver";
import { ApiClient } from "../api/client.js";
import { handleIfSessionExpired } from "./handle-session-expired.js";
import { MockApiClient } from "../api/mock-client.js";
import { getApiKey, getApiBase, getConfig, getJwt } from "../config/store.js";
import { NO_API_KEY_MSG } from "./auth-messages.js";
import type {
  AbilityCategory,
  UploadAbilityMetadata,
} from "../api/contracts.js";
import { error, p, handleCancel, jsonOut, jsonError } from "../ui/format.js";

function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

/** Zip an ability directory as <dirName>/<files> — the structure deploy expects. */
function zipAbilityDir(dirPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dirName = basename(dirPath);
    const outPath = join(tmpdir(), `openhome-deploy-${Date.now()}.zip`);
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
    // Files go under <dirName>/ — the top-level folder deploy requires
    archive.directory(dirPath, dirName);
    archive.finalize();
  });
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
    // skip unreadable dirs
  }
  return found;
}

export async function deployCommand(
  pathArg?: string,
  opts: {
    mock?: boolean;
    personality?: string;
    name?: string;
    description?: string;
    category?: string;
    triggers?: string;
    json?: boolean;
    timeout?: string; // seconds as string from commander
    template?: string;
  } = {},
): Promise<void> {
  if (!opts.json) p.intro("🚀 Upload Ability");

  const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) * 1000 : 120_000;

  let zipPath: string;

  if (pathArg) {
    const resolved = expandPath(pathArg);
    if (!existsSync(resolved)) {
      if (opts.json) jsonError("NOT_FOUND", `File not found: ${pathArg}`);
      error(`File not found: ${pathArg}`);
      process.exit(1);
    }
    zipPath = resolved;
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
      const options = [
        ...uniqueZips.map((z) => ({ value: z.path, label: z.label })),
        {
          value: "__custom__",
          label: "Other...",
          hint: "Enter a path manually",
        },
      ];
      const selected = await p.select({
        message: "Select your zip file",
        options,
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
        message: "Path to zip file",
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

  const zipName = basename(zipPath, ".zip");
  const defaultName = zipName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // In JSON mode all required fields must be provided as flags — no prompts
  if (opts.json) {
    const missing: string[] = [];
    if (!opts.name?.trim()) missing.push("--name");
    if (!opts.description?.trim()) missing.push("--description");
    if (
      !opts.category ||
      !["skill", "brain_skill", "background_daemon", "local"].includes(
        opts.category,
      )
    )
      missing.push("--category (skill|brain_skill|background_daemon|local)");
    if (!opts.triggers?.trim()) missing.push("--triggers");
    if (missing.length > 0) {
      jsonError(
        "MISSING_ARGS",
        `Missing required flags in --json mode: ${missing.join(", ")}`,
      );
      process.exit(1);
    }
  }

  let name: string;
  if (opts.name?.trim()) {
    name = opts.name.trim();
  } else {
    const nameInput = await p.text({
      message: "Ability name",
      placeholder: defaultName,
      validate: (val) => {
        if (!val?.trim()) return "Name is required";
      },
    });
    handleCancel(nameInput);
    name = (nameInput as string).trim() || defaultName;
  }

  let description: string;
  if (opts.description?.trim()) {
    description = opts.description.trim();
  } else {
    const descInput = await p.text({
      message: "Description",
      placeholder: "What does this ability do?",
      validate: (val) => {
        if (!val?.trim()) return "Description is required";
      },
    });
    handleCancel(descInput);
    description = (descInput as string).trim();
  }

  let category: AbilityCategory;
  if (
    opts.category &&
    ["skill", "brain_skill", "background_daemon", "local"].includes(
      opts.category,
    )
  ) {
    category = opts.category as AbilityCategory;
  } else {
    const catChoice = await p.select({
      message: "Category",
      options: [
        { value: "skill", label: "Skill", hint: "User-triggered" },
        { value: "brain_skill", label: "Brain Skill", hint: "Auto-triggered" },
        { value: "local", label: "Local", hint: "Runs on local device only" },
        {
          value: "background_daemon",
          label: "Background Daemon",
          hint: "Runs continuously",
        },
      ],
    });
    handleCancel(catChoice);
    category = catChoice as AbilityCategory;
  }

  let hotwords: string[];
  if (opts.triggers) {
    hotwords = opts.triggers
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  } else {
    const hotwordsInput = await p.text({
      message: "Trigger words (comma-separated)",
      placeholder: "hey openhome, activate skill",
      validate: (val) => {
        if (!val?.trim()) return "At least one trigger word is required";
      },
    });
    handleCancel(hotwordsInput);
    hotwords = (hotwordsInput as string)
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  }

  let needsApiKeys = false;
  if (!opts.json) {
    const confirmed = await p.confirm({
      message: "Does this ability require third party API keys?",
      initialValue: false,
    });
    handleCancel(confirmed);
    needsApiKeys = confirmed as boolean;
    if (needsApiKeys) {
      p.note(
        "After deploying, go to your ability settings in the dashboard to add API keys.",
        "Third Party API Keys",
      );
    }
  }

  const personalityId = opts.personality ?? getConfig().default_personality_id;

  const templateId = opts.template ? parseInt(opts.template, 10) : undefined;

  const metadata: UploadAbilityMetadata = {
    name,
    description,
    category,
    matching_hotwords: hotwords,
    personality_id: personalityId,
    ...(templateId !== undefined && !Number.isNaN(templateId)
      ? { template: templateId }
      : {}),
  };

  let zipBuffer: Buffer;
  const pathIsDir = existsSync(zipPath) && statSync(zipPath).isDirectory();
  if (pathIsDir) {
    const s2 = opts.json ? null : p.spinner();
    s2?.start(`Zipping ${basename(zipPath)}/...`);
    try {
      zipBuffer = await zipAbilityDir(zipPath);
      s2?.stop("Zipped.");
    } catch (err) {
      s2?.stop("Zip failed.");
      const msg = `Failed to zip directory: ${err instanceof Error ? err.message : String(err)}`;
      if (opts.json) jsonError("ZIP_ERROR", msg);
      error(msg);
      process.exit(1);
    }
  } else {
    try {
      zipBuffer = readFileSync(zipPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        const msg =
          `Permission denied: macOS is blocking access to this file.\n` +
          `  Fix: System Settings → Privacy & Security → Full Disk Access → enable your terminal\n` +
          `  Or move the zip: cp "${zipPath}" /tmp/${basename(zipPath)}`;
        if (opts.json) jsonError("EPERM", msg);
        error(msg);
      } else {
        const msg = `Could not read zip file: ${err instanceof Error ? err.message : String(err)}`;
        if (opts.json) jsonError("READ_ERROR", msg);
        error(msg);
      }
      process.exit(1);
    }
  } // end else (zip file path)

  if (opts.mock) {
    const s = opts.json ? null : p.spinner();
    s?.start("Uploading (mock)...");
    const mockClient = new MockApiClient();
    await mockClient.uploadAbility(zipBuffer, null, null, metadata);
    s?.stop("Mock upload complete.");
    if (opts.json) {
      jsonOut({ ok: true, mock: true, name, message: "Mock deploy complete." });
      return;
    }
    p.outro("Mock deploy complete.");
    return;
  }

  const apiKey = getApiKey() ?? "";
  const jwt = getJwt() ?? undefined;
  if (!apiKey) {
    if (opts.json) jsonError("UNAUTHENTICATED", NO_API_KEY_MSG, 2);
    error("Not authenticated. Run: openhome login");
    process.exit(1);
  }

  const s = opts.json ? null : p.spinner();
  s?.start("Uploading ability...");
  try {
    const client = new ApiClient(apiKey, getApiBase(), jwt);
    const result = await client.uploadAbility(
      zipBuffer,
      null,
      null,
      metadata,
      timeoutMs,
    );
    s?.stop("Upload complete.");

    const id = result.capability_id ?? result.ability_id ?? "—";

    if (opts.json) {
      jsonOut({
        ok: true,
        ability_id: String(id),
        name,
        version: result.version ?? null,
        status: result.status ?? null,
        message: result.detail ?? result.message ?? "Deployed successfully.",
      });
      return;
    }

    const lines = [
      `Ability ID: ${id}`,
      result.version != null ? `Version:    ${result.version}` : "",
      result.status ? `Status:     ${result.status}` : "",
      (result.detail ?? result.message)
        ? `Message:    ${result.detail ?? result.message}`
        : "",
    ].filter(Boolean);
    p.note(lines.join("\n"), "Deploy Result");
    p.outro("Deployed successfully!");
  } catch (err) {
    s?.stop("Upload failed.");
    if (await handleIfSessionExpired(err, opts)) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("same name")) {
      if (opts.json)
        jsonError(
          "DUPLICATE_NAME",
          `An ability named "${name}" already exists. Delete it first: openhome delete ${name} --yes`,
        );
      error(
        `An ability named "${name}" already exists. Delete it first: openhome delete`,
      );
    } else {
      if (opts.json) jsonError("ERROR", `Deploy failed: ${msg}`);
      error(`Deploy failed: ${msg}`);
    }
    process.exit(1);
  }
}
