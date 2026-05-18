import { describe, expect, it } from "vitest";
import { FrameLog } from "./frame-log.js";

describe("FrameLog", () => {
  it("records elapsed time and frame body", () => {
    let now = 1000;
    const log = new FrameLog(() => now);
    log.push("ws", "open");
    now = 1250;
    log.push("message", { content: "hi" });
    const lines = log.entries();
    expect(lines[0]).toMatch(/^0\.000s \[ws\] open$/);
    expect(lines[1]).toMatch(/^0\.250s \[message\] \{"content":"hi"\}$/);
  });

  it("truncates long bodies with an ellipsis", () => {
    const log = new FrameLog(() => 0);
    const big = "x".repeat(2000);
    log.push("blob", big);
    const line = log.entries()[0];
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(big.length);
  });

  it("serialize() ends with a newline when non-empty", () => {
    const log = new FrameLog(() => 0);
    log.push("ws", "open");
    expect(log.serialize().endsWith("\n")).toBe(true);
  });

  it("serialize() returns empty string when no entries", () => {
    const log = new FrameLog(() => 0);
    expect(log.serialize()).toBe("");
  });
});
