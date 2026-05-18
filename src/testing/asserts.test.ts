import { describe, expect, it } from "vitest";
import { Asserts } from "./asserts.js";

describe("Asserts", () => {
  it("done() is true when nothing is expected", () => {
    const a = new Asserts({ expectLog: [], expectSpeak: [], rejectSpeak: [] });
    expect(a.done()).toBe(true);
  });

  it("expectCap requires a matching chat_details name", () => {
    const a = new Asserts({
      expectCap: "my-skill",
      expectLog: [],
      expectSpeak: [],
      rejectSpeak: [],
    });
    expect(a.done()).toBe(false);
    a.observeChatDetails("other-skill");
    expect(a.done()).toBe(false);
    a.observeChatDetails("my-skill");
    expect(a.done()).toBe(true);
  });

  it("expectLog requires every regex to match at least one line", () => {
    const a = new Asserts({
      expectLog: [/STEP A0/, /probe returned/],
      expectSpeak: [],
      rejectSpeak: [],
    });
    a.observeAgentLog("STEP A0 — fetching ticket digest");
    expect(a.done()).toBe(false);
    a.observeAgentLog("STEP D probe returned 4 tickets");
    expect(a.done()).toBe(true);
  });

  it("expectSpeak requires every regex to match a final assistant message", () => {
    const a = new Asserts({
      expectLog: [],
      expectSpeak: [/Tickets:/, /total$/],
      rejectSpeak: [],
    });
    a.observeAssistantSpeak("Tickets: 4 total");
    expect(a.done()).toBe(true);
  });

  it("rejectSpeak fails the run when a forbidden phrase appears", () => {
    const a = new Asserts({
      expectLog: [],
      expectSpeak: [],
      rejectSpeak: [/couldn't generate/i],
    });
    expect(a.done()).toBe(true); // nothing forbidden has fired
    a.observeAssistantSpeak("I couldn't generate a response right now.");
    expect(a.done()).toBe(false);
    expect(a.rejected()).toBe(true);
  });

  it("rejectSpeak still records first hit even after benign messages", () => {
    const a = new Asserts({
      expectLog: [],
      expectSpeak: [/Tickets:/],
      rejectSpeak: [/missing files/],
    });
    a.observeAssistantSpeak("Tickets: 4 total");
    a.observeAssistantSpeak("Some files are missing files in the queue.");
    expect(a.rejected()).toBe(true);
    expect(a.done()).toBe(false);
  });

  it("toRecords reports met state for every expectation", () => {
    const a = new Asserts({
      expectCap: "my-skill",
      expectLog: [/STEP/],
      expectSpeak: [/hi/],
      rejectSpeak: [/bad/],
    });
    a.observeChatDetails("my-skill");
    a.observeAgentLog("STEP B");
    const records = a.toRecords();
    expect(records).toEqual([
      { kind: "cap", expression: "my-skill", met: true },
      { kind: "log", expression: "STEP", met: true },
      { kind: "speak", expression: "hi", met: false },
      { kind: "reject", expression: "bad", met: true },
    ]);
  });

  it("formatLines marks unmet assertions with ✗", () => {
    const a = new Asserts({
      expectLog: [/STEP A/],
      expectSpeak: [/hi/],
      rejectSpeak: [],
    });
    const lines = a.formatLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("✗");
    expect(lines[0]).toContain("STEP A");
  });
});
