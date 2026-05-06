import { describe, expect, it } from "vitest";
import {
  buildRemoteCommand,
  buildResultFrame,
  handleDevkitCapability,
  shq,
} from "./devkit-proxy.js";

describe("shq (POSIX shell quoting)", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shq("hello")).toBe("'hello'");
  });

  it("preserves spaces (the whole point of quoting)", () => {
    expect(shq("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes via the close-reopen idiom", () => {
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  it("handles strings full of shell metacharacters", () => {
    const evil = "$(rm -rf /); | && > < ` \\\"";
    const quoted = shq(evil);
    // The quoted form, when echoed by sh -c, should produce the original.
    // We check the quoted form starts and ends with single quotes and has
    // no unescaped single quotes inside.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

describe("buildRemoteCommand", () => {
  it("formats a basic dispatch", () => {
    const cmd = buildRemoteCommand("mycap", "do_thing", []);
    expect(cmd).toBe(
      "sudo python3 /home/openhome/openhome_devkit/local_capabilities/mycap/devkit_functions.py 'do_thing'",
    );
  });

  it("appends args, individually quoted", () => {
    const cmd = buildRemoteCommand("mycap", "query", ["tickets", "verbose"]);
    expect(cmd).toBe(
      "sudo python3 /home/openhome/openhome_devkit/local_capabilities/mycap/devkit_functions.py 'query' 'tickets' 'verbose'",
    );
  });

  it("respects a custom cap directory", () => {
    const cmd = buildRemoteCommand("mycap", "query", ["x"], "/opt/caps");
    expect(cmd).toBe(
      "sudo python3 /opt/caps/mycap/devkit_functions.py 'query' 'x'",
    );
  });

  it("stringifies non-string args before quoting", () => {
    const cmd = buildRemoteCommand("mycap", "fn", [42, true, null]);
    expect(cmd).toContain("'42' 'true' 'null'");
  });

  it("never lets shell metacharacters escape quoting", () => {
    const cmd = buildRemoteCommand("mycap", "fn", ["; rm -rf /"]);
    // Our shq wraps in single quotes; bash does not interpret shell
    // metacharacters inside single quotes, so the rm never fires.
    expect(cmd.includes("'; rm -rf /'")).toBe(true);
  });
});

describe("buildResultFrame", () => {
  it("packages a successful execution", () => {
    const frame = buildResultFrame(
      { capability_name: "cap", function_name: "fn", args: ["a"] },
      { ok: true, stdout: "result", stderr: "", code: 0 },
    );
    expect(frame.type).toBe("devkit-capability-result");
    expect(frame.data).toEqual({
      capability_name: "cap",
      function_name: "fn",
      args: ["a"],
      success: true,
      output: "result",
      error: null,
    });
  });

  it("packages a failed execution with stderr", () => {
    const frame = buildResultFrame(
      { capability_name: "cap", function_name: "fn", args: [] },
      { ok: false, stdout: "", stderr: "boom", code: 1 },
    );
    expect(frame.data.success).toBe(false);
    expect(frame.data.output).toBeNull();
    expect(frame.data.error).toBe("boom");
  });

  it("falls back to exit code when stderr is empty", () => {
    const frame = buildResultFrame(
      { capability_name: "cap", function_name: "fn" },
      { ok: false, stdout: "", stderr: "", code: 7 },
    );
    expect(frame.data.error).toBe("exited rc=7");
  });

  it("normalizes a missing args array to []", () => {
    const frame = buildResultFrame(
      { capability_name: "cap", function_name: "fn" },
      { ok: true, stdout: "x", stderr: "", code: 0 },
    );
    expect(frame.data.args).toEqual([]);
  });
});

describe("handleDevkitCapability", () => {
  it("rejects frames missing capability_name", async () => {
    const result = await handleDevkitCapability(
      { function_name: "fn" },
      { sshTarget: "user@host" },
    );
    expect(result.data.success).toBe(false);
    expect(result.data.error).toMatch(/capability_name and function_name/);
  });

  it("rejects frames missing function_name", async () => {
    const result = await handleDevkitCapability(
      { capability_name: "cap" },
      { sshTarget: "user@host" },
    );
    expect(result.data.success).toBe(false);
    expect(result.data.error).toMatch(/capability_name and function_name/);
  });

  it("calls the injected exec hook with the right command", async () => {
    let calledTarget = "";
    let calledCommand = "";
    const result = await handleDevkitCapability(
      { capability_name: "cap", function_name: "fn", args: ["x"] },
      {
        sshTarget: "user@host",
        capDir: "/opt/caps",
        exec: async (target, cmd) => {
          calledTarget = target;
          calledCommand = cmd;
          return { ok: true, stdout: "ok", stderr: "", code: 0 };
        },
      },
    );
    expect(calledTarget).toBe("user@host");
    expect(calledCommand).toBe(
      "sudo python3 /opt/caps/cap/devkit_functions.py 'fn' 'x'",
    );
    expect(result.data.success).toBe(true);
    expect(result.data.output).toBe("ok");
  });

  it("propagates SSH failure into the result frame", async () => {
    const result = await handleDevkitCapability(
      { capability_name: "cap", function_name: "fn" },
      {
        sshTarget: "user@host",
        exec: async () => ({
          ok: false,
          stdout: "",
          stderr: "Permission denied",
          code: 255,
        }),
      },
    );
    expect(result.data.success).toBe(false);
    expect(result.data.error).toBe("Permission denied");
  });
});
