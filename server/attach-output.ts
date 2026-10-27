/** herdr 0.9's terminal teardown immediately before its own stderr diagnostic. */
const TEARDOWN = "\x1b[?1049l\x1b[?25h\x1b[0 q";
/**
 * What herdr's attach writes last when it ends: the teardown, then why on stderr (taken over,
 * `terminal attach ended: terminal … not found` for a pane that closed, the server shut down).
 */
const DIAGNOSTIC = TEARDOWN + "herdr: ";
const TAKEN = DIAGNOSTIC + "server shut down: terminal attach taken over";

/** The attach's own final diagnostic, not these words in the pane's screen. */
export function isTakeoverExit(output: string): boolean {
  return output.trimEnd().endsWith(TAKEN);
}

/**
 * herdr 0.9.4+ `terminal attach` asks its outer terminal two questions before it attaches. The
 * bridge is that terminal: answered here, the queries never reach a browser or the replay, where
 * a browser joining later answered them again and herdr typed the late reply into the pane.
 */
const STARTUP_PROBES: ReadonlyArray<readonly [query: string, reply: string]> = [
  ["\x1b[?1016$p", "\x1b[?1016;4$y"], // pixel mouse coordinates (DECRQM): permanently off, cells it is
  ["\x1b[c", "\x1b[?1;2c"], // device attributes (DA1): xterm's answer, as the browser's terminal gave it
];

/** Takes the startup probes out of an attach's first output, across any read boundary. */
export class AttachStartupProbes {
  private partial = "";

  /**
   * The output without the probes, and the replies the attach is owed for them. `startup` says
   * whether output so far is still the attach's setup: from its first real byte on, the rest of
   * the read is the pane's and passes unchanged, whatever it holds.
   */
  take(data: string, startup: (output: string) => boolean): { output: string; replies: string } {
    let rest = this.partial + data;
    this.partial = "";
    let output = "";
    let replies = "";
    while (rest) {
      const probe = STARTUP_PROBES.find(([query]) => rest.startsWith(query));
      if (probe) {
        replies += probe[1];
        rest = rest.slice(probe[0].length);
      } else if (STARTUP_PROBES.some(([query]) => query.startsWith(rest))) {
        this.partial = rest;
        break;
      } else if (startup(output + rest[0])) {
        output += rest[0];
        rest = rest.slice(1);
      } else {
        output += rest;
        break;
      }
    }
    return { output, replies };
  }

  /** Held bytes that turned out not to start a probe, once startup is over. */
  flush(): string {
    const data = this.partial;
    this.partial = "";
    return data;
  }
}

/** longer words after the teardown are the pane's own output, not herdr's diagnostic */
const DIAGNOSTIC_MAX = 512;

/**
 * Hold only a possible trailing diagnostic of the attach until its exit confirms it: herdr's
 * words, never the pane's, are not painted into any client's terminal. Everything else passes
 * through unchanged, including the same words in the pane's normal screen output.
 */
export class AttachOutputTail {
  private tail = "";

  get pending(): boolean { return this.tail.length > 0; }

  push(data: string): string {
    const text = this.tail + data;
    this.tail = "";
    const full = text.lastIndexOf(DIAGNOSTIC);
    const words = full === -1 ? "" : text.slice(full + DIAGNOSTIC.length);
    if (full !== -1 && words.length <= DIAGNOSTIC_MAX && !words.includes("\x1b")) {
      this.tail = text.slice(full);
      return text.slice(0, full);
    }
    // Reads may split at any byte in the teardown or diagnostic, including the first ESC.
    for (let length = Math.min(text.length, DIAGNOSTIC.length - 1); length > 0; length--) {
      if (text.endsWith(DIAGNOSTIC.slice(0, length))) {
        this.tail = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    return text;
  }

  /** What is held: without herdr's words when the attach `ended` right after them (its modes stay). */
  flush(ended = false): string {
    const data = ended && this.tail.startsWith(DIAGNOSTIC) ? TEARDOWN : this.tail;
    this.tail = "";
    return data;
  }
}
