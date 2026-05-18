/**
 * Assertion tracker for `openhome test`.
 *
 * Pure: no I/O, no clock — every observation is a method call. The command
 * driver feeds it WebSocket frames; this object decides when the run passes.
 */

export interface AssertOpts {
  expectCap?: string;
  expectLog: RegExp[];
  expectSpeak: RegExp[];
  rejectSpeak: RegExp[];
}

export interface AssertRecord {
  kind: "cap" | "log" | "speak" | "reject";
  expression: string;
  met: boolean;
  /** For reject-speak hits, the content that triggered the rejection. */
  hit?: string;
}

export class Asserts {
  readonly opts: AssertOpts;
  private capSeen = false;
  private logSeen: boolean[];
  private speakSeen: boolean[];
  private rejectHit: string | null = null;

  constructor(opts: AssertOpts) {
    this.opts = opts;
    this.logSeen = opts.expectLog.map(() => false);
    this.speakSeen = opts.expectSpeak.map(() => false);
  }

  observeChatDetails(name: string): void {
    if (this.opts.expectCap && name === this.opts.expectCap) {
      this.capSeen = true;
    }
  }

  observeAgentLog(message: string): void {
    this.opts.expectLog.forEach((re, i) => {
      if (!this.logSeen[i] && re.test(message)) this.logSeen[i] = true;
    });
  }

  observeAssistantSpeak(content: string): void {
    this.opts.expectSpeak.forEach((re, i) => {
      if (!this.speakSeen[i] && re.test(content)) this.speakSeen[i] = true;
    });
    if (!this.rejectHit) {
      for (const re of this.opts.rejectSpeak) {
        if (re.test(content)) {
          this.rejectHit = content;
          break;
        }
      }
    }
  }

  /** True when every expectation is satisfied and no reject pattern matched. */
  done(): boolean {
    if (this.rejectHit) return false;
    if (this.opts.expectCap && !this.capSeen) return false;
    if (this.logSeen.some((s) => !s)) return false;
    if (this.speakSeen.some((s) => !s)) return false;
    return true;
  }

  /** True only if a reject pattern fired — distinguishes "failed" from "not yet done". */
  rejected(): boolean {
    return this.rejectHit !== null;
  }

  toRecords(): AssertRecord[] {
    const records: AssertRecord[] = [];
    if (this.opts.expectCap) {
      records.push({
        kind: "cap",
        expression: this.opts.expectCap,
        met: this.capSeen,
      });
    }
    this.opts.expectLog.forEach((re, i) => {
      records.push({
        kind: "log",
        expression: re.source,
        met: this.logSeen[i],
      });
    });
    this.opts.expectSpeak.forEach((re, i) => {
      records.push({
        kind: "speak",
        expression: re.source,
        met: this.speakSeen[i],
      });
    });
    this.opts.rejectSpeak.forEach((re) => {
      records.push({
        kind: "reject",
        expression: re.source,
        met: !this.rejectHit,
        ...(this.rejectHit ? { hit: this.rejectHit } : {}),
      });
    });
    return records;
  }

  /** Human-readable per-assertion lines for stdout. */
  formatLines(): string[] {
    const lines: string[] = [];
    const tick = (b: boolean) => (b ? "✓" : "✗");
    if (this.opts.expectCap) {
      lines.push(`  cap   ${tick(this.capSeen)} chat_details:{name:"${this.opts.expectCap}"}`);
    }
    this.opts.expectLog.forEach((re, i) => {
      lines.push(`  log   ${tick(this.logSeen[i])} /${re.source}/`);
    });
    this.opts.expectSpeak.forEach((re, i) => {
      lines.push(`  speak ${tick(this.speakSeen[i])} /${re.source}/`);
    });
    if (this.rejectHit) {
      lines.push(`  ✗ rejected speak landed: ${this.rejectHit.slice(0, 80)}`);
    }
    return lines;
  }
}
