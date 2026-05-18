/**
 * SSH-based proxy that lets `openhome test` exercise Local Abilities
 * without needing the kiosk session to be the active WS.
 *
 * Why this exists:
 *
 * `openhome test` opens its own voice-stream WebSocket to test the
 * agent. That displaces the DevKit kiosk's WS — the cloud now considers
 * us the agent's device. Fine for Skill / Brain Skill / Background
 * Daemon abilities, where everything runs in the cloud sandbox. Breaks
 * for Local Abilities: when `main.py` calls
 * `send_devkit_capability_action()`, the cloud sends a
 * `devkit-capability` frame back through OUR WS, expecting a
 * `devkit-capability-result` ACK from the device. We aren't the device.
 *
 * --proxy-pi <ssh-target> turns the test command into a kiosk
 * stand-in. We mirror exactly what the on-device node-server does
 * (`openhome-node-server/index.js:585+`): SSH-exec
 * `sudo python3 .../<capability_name>/devkit_functions.py
 * <function_name> <args...>` on the DevKit, capture stdout, and ACK.
 * The cloud sees a normal device round-trip and main.py's `await
 * send_devkit_capability_action` resolves with the function's stdout.
 */
import { spawn } from "node:child_process";

export interface DevkitCapabilityFrame {
  capability_name?: string;
  function_name?: string;
  args?: unknown[];
}

export interface DevkitCapabilityResult {
  type: "devkit-capability-result";
  data: {
    capability_name: string | null;
    function_name: string | null;
    args: unknown[];
    success: boolean;
    output: string | null;
    error: string | null;
  };
}

export interface SshExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

const SSH_CONNECT_TIMEOUT_S = 5;
const DEFAULT_CAP_DIR = "/home/openhome/openhome_devkit/local_capabilities";

/**
 * Allowlist for capability_name and function_name. These arrive from the
 * OpenHome cloud WebSocket and are embedded in a remote `sudo python3 ...`
 * invocation, so they must be tightly constrained. POSIX-portable identifier
 * pattern: alphanumeric plus underscore and hyphen.
 */
export const SAFE_IDENT = /^[a-zA-Z0-9_-]+$/;

/**
 * POSIX shell-escape a string. Wraps in single quotes and escapes any
 * embedded single quotes via `'\\''`. Safe for use inside a remote
 * `sudo python3 ...` invocation.
 *
 * Exported for unit testing.
 */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the remote command the proxy will run for a given dispatch.
 * Pure — used by both the runtime and the unit tests.
 *
 * Callers MUST validate capabilityName and functionName against SAFE_IDENT
 * before reaching this function (handleDevkitCapability does so). We still
 * defence-in-depth `shq()` every interpolated value here.
 */
export function buildRemoteCommand(
  capabilityName: string,
  functionName: string,
  args: unknown[],
  capDir: string = DEFAULT_CAP_DIR,
): string {
  const script = `${capDir}/${capabilityName}/devkit_functions.py`;
  const argsShell = args.map((a) => shq(String(a))).join(" ");
  return `sudo python3 ${shq(script)} ${shq(functionName)}${argsShell ? " " + argsShell : ""}`.trim();
}

/**
 * Run a command on the remote SSH target and return its stdout/stderr.
 * Uses BatchMode + ConnectTimeout to fail fast on missing keys.
 */
export function sshExec(
  target: string,
  command: string,
): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
      "--", // prevent SSH option-injection from target values starting with `-`
      target,
      command,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => {
      resolve({ ok: false, stdout: "", stderr: err.message, code: -1 });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
      });
    });
  });
}

/**
 * Build the `devkit-capability-result` payload the cloud expects after
 * a `devkit-capability` dispatch. Pure — easy to unit-test.
 */
export function buildResultFrame(
  frame: DevkitCapabilityFrame,
  ssh: SshExecResult,
): DevkitCapabilityResult {
  return {
    type: "devkit-capability-result",
    data: {
      capability_name: frame.capability_name ?? null,
      function_name: frame.function_name ?? null,
      args: Array.isArray(frame.args) ? frame.args : [],
      success: ssh.ok,
      output: ssh.stdout || null,
      error: ssh.ok ? null : (ssh.stderr || `exited rc=${ssh.code}`),
    },
  };
}

export interface ProxyOptions {
  sshTarget: string;
  capDir?: string;
  exec?: (target: string, command: string) => Promise<SshExecResult>;
}

/**
 * Handle a single devkit-capability dispatch. Resolves with the frame
 * to send back over the WS. The `exec` hook is exposed so tests can
 * inject a fake SSH executor without touching the network.
 */
export async function handleDevkitCapability(
  frame: DevkitCapabilityFrame,
  opts: ProxyOptions,
): Promise<DevkitCapabilityResult> {
  const cap = frame.capability_name;
  const fn = frame.function_name;
  if (!cap || !fn) {
    return {
      type: "devkit-capability-result",
      data: {
        capability_name: cap ?? null,
        function_name: fn ?? null,
        args: Array.isArray(frame.args) ? frame.args : [],
        success: false,
        output: null,
        error: "capability_name and function_name are required",
      },
    };
  }
  // STRICT ALLOWLIST: capability_name and function_name arrive from the
  // OpenHome cloud WebSocket and are embedded in a remote sudo shell
  // invocation. Block anything outside [a-zA-Z0-9_-] before it gets near
  // buildRemoteCommand — prevents shell injection AND path traversal
  // (e.g. capability_name "../../../tmp/evil").
  if (!SAFE_IDENT.test(cap) || !SAFE_IDENT.test(fn)) {
    return {
      type: "devkit-capability-result",
      data: {
        capability_name: cap,
        function_name: fn,
        args: Array.isArray(frame.args) ? frame.args : [],
        success: false,
        output: null,
        error: "capability_name and function_name must match [a-zA-Z0-9_-]+",
      },
    };
  }
  const command = buildRemoteCommand(
    cap,
    fn,
    Array.isArray(frame.args) ? frame.args : [],
    opts.capDir ?? DEFAULT_CAP_DIR,
  );
  const exec = opts.exec ?? sshExec;
  const result = await exec(opts.sshTarget, command);
  return buildResultFrame(frame, result);
}
