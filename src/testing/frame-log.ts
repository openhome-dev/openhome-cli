/**
 * Captures the WebSocket frame stream for `openhome test`.
 *
 * Each entry records elapsed time + frame type + body. Bodies are JSON-serialized
 * with a length cap so the log stays useful when something dumps a megabyte of
 * audio metadata.
 */

const BODY_PREVIEW_CHARS = 600;

export class FrameLog {
  private readonly t0: number;
  private readonly lines: string[] = [];

  constructor(now: () => number = Date.now) {
    this.t0 = now();
    this.now = now;
  }

  private readonly now: () => number;

  push(kind: string, body: unknown): void {
    const dt = ((this.now() - this.t0) / 1000).toFixed(3);
    let bodyStr: string;
    if (typeof body === "string") {
      bodyStr = body;
    } else {
      try {
        bodyStr = JSON.stringify(body);
      } catch {
        bodyStr = String(body);
      }
    }
    if (bodyStr.length > BODY_PREVIEW_CHARS) {
      bodyStr = bodyStr.slice(0, BODY_PREVIEW_CHARS) + "…";
    }
    this.lines.push(`${dt}s [${kind}] ${bodyStr}`);
  }

  /** Frame log as a single string ready to dump to disk. */
  serialize(): string {
    return this.lines.join("\n") + (this.lines.length > 0 ? "\n" : "");
  }

  /** Snapshot of recorded lines (mostly for tests). */
  entries(): readonly string[] {
    return this.lines;
  }
}
