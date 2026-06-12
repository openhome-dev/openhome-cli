export const REQUIRED_FILES = ["main.py", "__init__.py"];
export const RECOMMENDED_FILES = ["README.md"];

export const BLOCKED_IMPORTS = [
  "redis",
  "from src.utils.db_handler",
  "connection_manager",
  "user_config",
];

export interface BlockedPattern {
  regex: RegExp;
  message: string;
}

export const BLOCKED_PATTERNS: BlockedPattern[] = [
  {
    regex: /\bprint\s*\(/,
    message: "Use self.worker.editor_logging_handler instead of print()",
  },
  {
    regex: /\basyncio\.sleep\s*\(/,
    message: "Use self.worker.session_tasks.sleep() instead",
  },
  {
    regex: /\basyncio\.create_task\s*\(/,
    message: "Use self.worker.session_tasks.create() instead",
  },
  { regex: /\bexec\s*\(/, message: "exec() not allowed" },
  { regex: /\beval\s*\(/, message: "eval() not allowed" },
  { regex: /\bpickle\./, message: "pickle not allowed" },
  { regex: /\bdill\./, message: "dill not allowed" },
  { regex: /\bshelve\./, message: "shelve not allowed" },
  { regex: /\bmarshal\./, message: "marshal not allowed" },
  {
    regex: /\bopen\s*\(/,
    message: "raw open() not allowed — use capability_worker file helpers",
  },
  { regex: /\bassert\s+/, message: "assert not allowed" },
  { regex: /\bhashlib\.md5\s*\(/, message: "MD5 not allowed" },
];

export interface RequiredPattern {
  regex: RegExp;
  message: string;
}

export const REQUIRED_PATTERNS: RequiredPattern[] = [
  {
    regex: /resume_normal_flow\s*\(/,
    message: "resume_normal_flow() must be called",
  },
  {
    regex: /class\s+\w+.*MatchingCapability/,
    message: "Class must extend MatchingCapability",
  },
  { regex: /def\s+call\s*\(/, message: "Must have a call() method" },
  {
    regex: /worker\s*:\s*AgentWorker\s*=\s*None/,
    message: "Must declare worker: AgentWorker = None",
  },
  {
    regex: /capability_worker\s*:\s*CapabilityWorker\s*=\s*None/,
    message: "Must declare capability_worker: CapabilityWorker = None",
  },
];

// Detect committed API keys across common providers. The previous
// pattern caught only sk_/sk-/key_ prefixes followed by alphanumerics,
// which missed:
//   - OpenAI project keys: sk-proj-...                  (allow dashes/underscores past prefix)
//   - Anthropic keys:      sk-ant-...                   (same)
//   - Stripe live/test:    sk_live_..., sk_test_...      (allow underscores past prefix)
//   - GitHub PATs:         ghp_, ghs_, ghu_, gho_, ghr_  (40-char body)
//   - AWS access keys:     AKIA, ASIA + 16 chars         (exactly 16, all upper/digit)
//   - Slack bot tokens:    xoxb-, xoxa-, xoxp-, xoxr-, xoxs-
//   - Google API keys:     AIza + 35 chars
// Each branch is anchored so we don't false-positive on Python
// identifiers like `key_count`.
export const HARDCODED_KEY_PATTERN = new RegExp(
  [
    // OpenAI / Anthropic / Stripe-style with optional sub-prefix
    "(?:sk[-_])(?:proj[-_]|ant[-_]|live[-_]|test[-_])?[A-Za-z0-9_-]{20,}",
    // Legacy "key_" prefix (Replicate, etc.)
    "key_[A-Za-z0-9]{20,}",
    // GitHub tokens
    "gh[pousr]_[A-Za-z0-9]{36}",
    // AWS access keys
    "(?:AKIA|ASIA)[A-Z0-9]{16}",
    // Slack tokens
    "xox[bapr-s]-[A-Za-z0-9-]{10,}",
    // Google API keys
    "AIza[A-Za-z0-9_-]{35}",
  ].join("|"),
);

export const MULTIPLE_CLASSES_PATTERN = /^class\s+/gm;
