import { writeFile } from "node:fs/promises";
import { getApiKey, getConfig, getApiBase } from "../config/store.js";
import { ApiClient } from "../api/client.js";
import {
  error,
  success,
  info,
  p,
  handleCancel,
  jsonOut,
} from "../ui/format.js";
import { createAgentSocket } from "../ws/agent-socket.js";
import { Asserts, type AssertOpts } from "../testing/asserts.js";
import { FrameLog } from "../testing/frame-log.js";
import { handleDevkitCapability } from "../testing/devkit-proxy.js";
import chalk from "chalk";

export interface TestOptions {
  agent?: string;
  trigger?: string;
  expectCap?: string;
  expectLog?: string[];
  expectSpeak?: string[];
  rejectSpeak?: string[];
  timeout?: string;
  logFile?: string;
  quiet?: boolean;
  json?: boolean;
  /**
   * SSH target for Local Ability proxying (`user@host`). When set, the
   * test command intercepts `devkit-capability` frames from the cloud,
   * SSH-execs `sudo python3 .../<cap>/devkit_functions.py <fn> <args>`
   * on the DevKit, and ACKs with `devkit-capability-result`. Required
   * for end-to-end tests of `category=local` abilities, since opening
   * a fresh voice-stream WS displaces the kiosk session that would
   * otherwise handle the dispatch.
   */
  proxyPi?: string;
  /** Override the default `local_capabilities` directory path on the DevKit. */
  proxyPiCapDir?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOG_FILE = "/tmp/openhome-test.log";
const TRIGGER_DELAY_MS = 300;

export async function testCommand(
  triggerArg?: string,
  opts: TestOptions = {},
): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    if (opts.json) {
      jsonOut({
        ok: false,
        error: { code: "AUTH_ERROR", message: "Not authenticated" },
      });
      process.exit(2);
    }
    error("Not authenticated. Run: openhome login");
    process.exit(2);
  }

  if (!opts.json) {
    p.intro("🧪 Test ability against live agent");
  }

  // Resolve trigger phrase
  let trigger = triggerArg ?? opts.trigger;
  if (!trigger) {
    if (opts.json) {
      jsonOut({
        ok: false,
        error: { code: "MISSING_TRIGGER", message: "--trigger is required" },
      });
      process.exit(2);
    }
    const input = await p.text({
      message: "Trigger phrase",
      validate: (val) => {
        if (!val?.trim()) return "A trigger phrase is required";
      },
    });
    handleCancel(input);
    trigger = (input as string).trim();
  }

  // Resolve agent (default → from config → interactive picker)
  let agentId = opts.agent ?? getConfig().default_personality_id;
  if (!agentId) {
    if (opts.json) {
      jsonOut({
        ok: false,
        error: {
          code: "MISSING_AGENT",
          message:
            "No agent specified and no default set. Pass --agent or run: openhome agents",
        },
      });
      process.exit(2);
    }
    const s = p.spinner();
    s.start("Fetching agents...");
    try {
      const client = new ApiClient(apiKey, getApiBase());
      const agents = await client.getPersonalities();
      s.stop(`Found ${agents.length} agent(s).`);
      if (agents.length === 0) {
        error("No agents found.");
        process.exit(1);
      }
      const selected = await p.select({
        message: "Which agent?",
        options: agents.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
      });
      handleCancel(selected);
      agentId = selected as string;
    } catch (err) {
      s.stop("Failed.");
      error(
        `Could not fetch agents: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  // Build assertion opts (pre-compile regexes so bad input fails fast).
  let assertOpts: AssertOpts;
  try {
    assertOpts = {
      expectCap: opts.expectCap,
      expectLog: (opts.expectLog ?? []).map((s) => new RegExp(s)),
      expectSpeak: (opts.expectSpeak ?? []).map((s) => new RegExp(s)),
      rejectSpeak: (opts.rejectSpeak ?? []).map((s) => new RegExp(s)),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      jsonOut({
        ok: false,
        error: { code: "BAD_REGEX", message: msg },
      });
      process.exit(2);
    }
    error(`Invalid regex in flags: ${msg}`);
    process.exit(2);
  }

  const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    error(`Invalid --timeout value: ${opts.timeout}`);
    process.exit(2);
  }
  const logFile = opts.logFile ?? DEFAULT_LOG_FILE;

  const asserts = new Asserts(assertOpts);
  const log = new FrameLog();

  if (!opts.json && !opts.quiet) {
    info(
      `Sending "${chalk.bold(trigger)}" to agent ${chalk.bold(agentId)} ` +
        `(timeout ${(timeoutMs / 1000).toFixed(0)}s)`,
    );
  }

  let triggerSent = false;
  let settled = false;
  let resolveDone!: (r: { pass: boolean; reason?: string }) => void;
  const done = new Promise<{ pass: boolean; reason?: string }>((resolve) => {
    resolveDone = resolve;
  });

  const t0 = Date.now();

  const settle = (result: { pass: boolean; reason?: string }) => {
    if (settled) return;
    settled = true;
    resolveDone(result);
  };

  const socket = createAgentSocket({
    apiKey,
    agentId,
    baseUrl: getApiBase()
      ?.replace("https://", "wss://")
      .replace("http://", "ws://"),

    onConnect() {
      log.push("ws", "open");
    },

    onTextMessage(content, role, { final }) {
      // Wait for the wake greeting (assistant final message) before sending the
      // trigger — this ensures the agent's session is fully initialized.
      if (
        !triggerSent &&
        role === "assistant" &&
        final &&
        !!content
      ) {
        triggerSent = true;
        setTimeout(() => {
          if (settled) return;
          log.push("test", `sending trigger "${trigger}"`);
          socket.send("transcribed", trigger);
        }, TRIGGER_DELAY_MS);
        return;
      }

      // Final assistant speech feeds expect-speak / reject-speak.
      if (role === "assistant" && final && content) {
        asserts.observeAssistantSpeak(content);
        // Fast-settle on a reject-speak hit. Without this, done() returns
        // false permanently when a rejection fires (asserts deliberately
        // never marks itself "done" on rejection) and the run idles until
        // timeout — the JSON output then reports reason: "timeout" instead
        // of the actual rejected content.
        if (asserts.rejected()) {
          const hit =
            asserts
              .toRecords()
              .find((r) => r.kind === "reject" && r.hit)?.hit ?? "";
          settle({
            pass: false,
            reason: `rejected-speak: ${hit.slice(0, 120)}`,
          });
          socket.close();
          return;
        }
      }
    },

    onEvent(type, data) {
      // Skip noisy audio frames in the log (still allow other types through).
      if (type !== "audio" && type !== "audio-frame") {
        log.push(type, data);
      }

      // chat_details routing event — distinguishes which capability the cloud
      // routed the trigger to.
      if (type === "message") {
        const d = data as { chat_details?: { name?: string } };
        if (d?.chat_details?.name) {
          asserts.observeChatDetails(d.chat_details.name);
        }
      }

      // Local Ability proxy: when --proxy-pi is set, mirror what the
      // DevKit's node-server would do on receipt of this frame.
      if (type === "devkit-capability" && opts.proxyPi) {
        const frame = (data ?? {}) as {
          capability_name?: string;
          function_name?: string;
          args?: unknown[];
        };
        log.push(
          "proxy-pi",
          `${frame.capability_name}.${frame.function_name}(${JSON.stringify(frame.args ?? [])})`,
        );
        handleDevkitCapability(frame, {
          sshTarget: opts.proxyPi,
          capDir: opts.proxyPiCapDir,
        })
          .then((resultFrame) => {
            log.push(
              "proxy-pi",
              `result success=${resultFrame.data.success} chars=${
                (resultFrame.data.output ?? "").length
              }`,
            );
            // The agent-socket.send wrapper takes (type, data); the cloud's
            // ACK schema expects the WHOLE frame as the payload.
            socket.send(resultFrame.type, resultFrame.data);
          })
          .catch((err: unknown) => {
            // Without an explicit .catch() here, any throw inside
            // handleDevkitCapability or buildRemoteCommand becomes an
            // unhandled rejection — Node 15+ terminates the process with
            // no log file written and no JSON output for CI consumers.
            const msg = err instanceof Error ? err.message : String(err);
            log.push("proxy-pi-error", msg);
            settle({ pass: false, reason: `devkit proxy error: ${msg}` });
            socket.close();
          });
      }

      // Cloud agent log lines arrive as {type:"log", data:{l, m}} — our
      // editor_logging_handler.info() calls land as `m` strings.
      if (type === "log") {
        const d = data as { m?: string };
        if (typeof d?.m === "string") {
          asserts.observeAgentLog(d.m);
        }
      }

      if (asserts.done()) {
        settle({ pass: true });
        socket.close();
      }
    },

    onError(err) {
      log.push("ws-error", err.message);
      settle({ pass: false, reason: `ws error: ${err.message}` });
      socket.close();
    },

    onClose(code) {
      log.push("ws", `close code=${code}`);
      if (!asserts.done()) {
        settle({ pass: false, reason: `ws closed code=${code}` });
      }
    },
  });

  const timer = setTimeout(() => {
    settle({ pass: false, reason: "timeout" });
    socket.close();
  }, timeoutMs);

  const result = await done;
  clearTimeout(timer);

  // Best-effort log dump — never fail the run because we couldn't write it.
  let logFileWritten: string | null = null;
  try {
    await writeFile(logFile, log.serialize());
    logFileWritten = logFile;
  } catch {
    /* ignore — log file is a debugging aid */
  }

  const elapsedMs = Date.now() - t0;

  if (opts.json) {
    jsonOut({
      ok: result.pass,
      pass: result.pass,
      reason: result.reason ?? null,
      elapsed_ms: elapsedMs,
      asserts: asserts.toRecords(),
      log_file: logFileWritten,
      agent: agentId,
      trigger,
    });
    process.exit(result.pass ? 0 : 1);
  }

  if (!opts.quiet) {
    const reportLines = asserts.formatLines();
    if (reportLines.length > 0) {
      console.log(reportLines.join("\n"));
    }
    if (logFileWritten) {
      console.log(chalk.gray(`  log file: ${logFileWritten}`));
    }
  }

  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  if (result.pass) {
    success(`PASS (${elapsedSec}s)`);
    process.exit(0);
  }
  error(`FAIL (${elapsedSec}s) — ${result.reason ?? "assertions not met"}`);
  process.exit(1);
}

/** Commander accumulator for repeatable flags (--expect-log, --expect-speak, ...). */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}
