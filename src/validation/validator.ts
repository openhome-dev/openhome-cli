import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_FILES,
  RECOMMENDED_FILES,
  BLOCKED_IMPORTS,
  BLOCKED_PATTERNS,
  REQUIRED_PATTERNS,
  HARDCODED_KEY_PATTERN,
  MULTIPLE_CLASSES_PATTERN,
} from "./rules.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  file?: string;
}

export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function readFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function validateAbility(dirPath: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Required files (errors)
  for (const required of REQUIRED_FILES) {
    if (!existsSync(join(dirPath, required))) {
      errors.push({
        severity: "error",
        message: `Missing required file: ${required}`,
        file: required,
      });
    }
  }

  // 2. Recommended files (warnings)
  for (const recommended of RECOMMENDED_FILES) {
    if (!existsSync(join(dirPath, recommended))) {
      warnings.push({
        severity: "warning",
        message: `Missing recommended file: ${recommended}`,
        file: recommended,
      });
    }
  }

  // 3. Validate config.json
  const configPath = join(dirPath, "config.json");
  if (existsSync(configPath)) {
    const configContent = readFile(configPath);
    if (configContent) {
      try {
        const config = JSON.parse(configContent) as Record<string, unknown>;
        if (typeof config.unique_name !== "string" || !config.unique_name) {
          errors.push({
            severity: "error",
            message: "config.json: unique_name must be a non-empty string",
            file: "config.json",
          });
        }
        if (
          !Array.isArray(config.matching_hotwords) ||
          !(config.matching_hotwords as unknown[]).every(
            (h) => typeof h === "string",
          )
        ) {
          errors.push({
            severity: "error",
            message:
              "config.json: matching_hotwords must be an array of strings",
            file: "config.json",
          });
        }
      } catch {
        errors.push({
          severity: "error",
          message: "config.json: invalid JSON",
          file: "config.json",
        });
      }
    }
  } else {
    errors.push({
      severity: "error",
      message: "Missing required file: config.json",
      file: "config.json",
    });
  }

  // 4. Validate main.py
  const mainPath = join(dirPath, "main.py");
  const mainContent = readFile(mainPath);

  if (mainContent) {
    const lines = mainContent.split("\n");

    // Blocked imports
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        !line.startsWith("import ") &&
        !line.startsWith("from ") &&
        !line.includes("import ")
      )
        continue;
      for (const blocked of BLOCKED_IMPORTS) {
        if (line.includes(blocked)) {
          errors.push({
            severity: "error",
            message: `Blocked import "${blocked}" on line ${i + 1}`,
            file: "main.py",
          });
        }
      }
    }

    // Blocked patterns (line by line)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { regex, message } of BLOCKED_PATTERNS) {
        if (regex.test(line)) {
          errors.push({
            severity: "error",
            message: `${message} (line ${i + 1})`,
            file: "main.py",
          });
        }
      }
    }

    // Required patterns (whole file)
    for (const { regex, message } of REQUIRED_PATTERNS) {
      if (!regex.test(mainContent)) {
        errors.push({ severity: "error", message, file: "main.py" });
      }
    }

    // Hardcoded key warning
    if (HARDCODED_KEY_PATTERN.test(mainContent)) {
      warnings.push({
        severity: "warning",
        message: `Possible hardcoded API key detected — use capability_worker.get_single_key() instead`,
        file: "main.py",
      });
    }

    // Multiple classes warning
    const classMatches = mainContent.match(MULTIPLE_CLASSES_PATTERN);
    if (classMatches && classMatches.length > 1) {
      warnings.push({
        severity: "warning",
        message: `Multiple class definitions found (${classMatches.length}). Only one MatchingCapability class is expected.`,
        file: "main.py",
      });
    }
  }

  // 5. Scan other .py files for blocked patterns
  let pyFiles: string[] = [];
  try {
    pyFiles = readdirSync(dirPath).filter(
      (f) => f.endsWith(".py") && f !== "main.py",
    );
  } catch {
    // ignore
  }

  for (const pyFile of pyFiles) {
    const content = readFile(join(dirPath, pyFile));
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { regex, message } of BLOCKED_PATTERNS) {
        if (regex.test(line)) {
          errors.push({
            severity: "error",
            message: `${message} (line ${i + 1})`,
            file: pyFile,
          });
        }
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
