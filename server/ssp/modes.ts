/**
 * What the screen does not hold of an attach stream: the terminal modes the browser's input
 * encoding follows, and the program's clipboard writes (OSC 52). Read as the stream goes by,
 * across any chunk boundary, beside the headless terminal that keeps the screen (screen.ts).
 *
 * Strings (OSC, DCS, APC, PM, SOS) are skipped whole, so a sequence inside one is never read as a
 * mode change; only an OSC 52 is kept, up to MAX_STRING.
 */
import { DEFAULT_MODES, type Modes } from "../../shared/ssp.ts";

/** Longer strings are skipped unread: an OSC 52 past the browser's own limit (osc52.ts) is dropped there anyway. */
const MAX_STRING = 200 * 1024;
const MAX_PARAMS = 64;

const MOUSE_TRACKING = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODING = new Set([1005, 1006, 1015, 1016]);

type State = "ground" | "esc" | "csi" | "string" | "string-esc";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class ModeTracker {
  private modes: Mutable<Modes> = { ...DEFAULT_MODES };
  private state: State = "ground";
  private params = "";
  private intermediates = "";
  /** the string's introducer: "]" OSC, "P" DCS, "_" APC, "^" PM, "X" SOS */
  private stringKind = "";
  private string = "";
  private stringOverflow = false;
  private clipboard: { seq: number; payload: string } | null = null;
  /** a full reset (RIS) went by in the last `feed`: the screen's own settings need saying again */
  resetSeen = false;

  /** the modes now; kitty keyboard flags come from the terminal (screen.ts) */
  get current(): Modes {
    return this.modes;
  }

  get clip(): { seq: number; payload: string } | null {
    return this.clipboard;
  }

  feed(data: string): void {
    this.resetSeen = false;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      switch (this.state) {
        case "ground":
          if (code === 0x1b) this.state = "esc";
          break;
        case "esc":
          this.escape(code);
          break;
        case "csi":
          this.csi(code);
          break;
        case "string":
          if (code === 0x07 && this.stringKind === "]") this.endString();
          else if (code === 0x1b) this.state = "string-esc";
          else this.collect(data[i]!);
          break;
        case "string-esc":
          if (code === 0x5c) this.endString();
          else {
            // an ESC that does not end the string (ESC \) aborts it, as a terminal does
            this.state = "esc";
            this.escape(code);
          }
          break;
      }
    }
  }

  private escape(code: number): void {
    this.state = "ground";
    switch (code) {
      case 0x5b: this.startCsi(); break; // [
      case 0x5d: this.startString("]"); break;
      case 0x50: this.startString("P"); break;
      case 0x5f: this.startString("_"); break;
      case 0x5e: this.startString("^"); break;
      case 0x58: this.startString("X"); break;
      case 0x3d: this.modes.keypad = true; break; // ESC =
      case 0x3e: this.modes.keypad = false; break; // ESC >
      case 0x63: this.fullReset(); break; // ESC c
      case 0x1b: this.state = "esc"; break;
      default:
        // ESC with intermediates (charset designations and the like) takes one more byte
        if (code >= 0x20 && code <= 0x2f) this.state = "esc";
    }
  }

  private startCsi(): void {
    this.state = "csi";
    this.params = "";
    this.intermediates = "";
  }

  private csi(code: number): void {
    if (code >= 0x30 && code <= 0x3f) {
      if (this.params.length < MAX_PARAMS) this.params += String.fromCharCode(code);
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediates += String.fromCharCode(code);
      return;
    }
    if (code === 0x1b) {
      this.state = "esc";
      return;
    }
    this.state = "ground";
    if (code < 0x40 || code > 0x7e) return;
    this.dispatchCsi(String.fromCharCode(code));
  }

  private dispatchCsi(final: string): void {
    const prefix = /^[<=>?]/.test(this.params) ? this.params[0]! : "";
    const body = prefix ? this.params.slice(1) : this.params;
    const values = body === "" ? [] : body.split(";").map((part) => {
      const value = Number.parseInt(part.split(":")[0]!, 10);
      return Number.isFinite(value) ? value : 0;
    });
    if (this.intermediates === "!" && final === "p" && prefix === "") {
      this.softReset();
      return;
    }
    if (this.intermediates !== "") return;
    if (prefix === "?" && (final === "h" || final === "l")) {
      for (const value of values) this.privateMode(value, final === "h");
      return;
    }
    if (prefix === ">" && (final === "m" || final === "n")) {
      // xterm's modifyOtherKeys: CSI > 4 ; level m sets it, CSI > 4 n or a bare reset turns it off
      if (values.length === 0 || (values.length === 1 && values[0] === 0)) this.modes.modifyOtherKeys = 0;
      else if (values[0] === 4) this.modes.modifyOtherKeys = final === "m" ? values[1] ?? 0 : 0;
    }
  }

  private privateMode(mode: number, on: boolean): void {
    if (MOUSE_TRACKING.has(mode)) {
      if (on) this.modes.mouse = mode;
      else if (this.modes.mouse === mode) this.modes.mouse = 0;
      return;
    }
    if (MOUSE_ENCODING.has(mode)) {
      if (on) this.modes.mouseEncoding = mode;
      else if (this.modes.mouseEncoding === mode) this.modes.mouseEncoding = 0;
      return;
    }
    switch (mode) {
      case 1: this.modes.cursorKeys = on; break;
      case 1004: this.modes.focusEvents = on; break;
      case 1007: this.modes.alternateScroll = on; break;
      case 2004: this.modes.bracketedPaste = on; break;
      case 47: case 1047: case 1049: this.modes.altScreen = on; break;
    }
  }

  private softReset(): void {
    this.modes.cursorKeys = false;
    this.modes.keypad = false;
  }

  private fullReset(): void {
    this.modes = { ...DEFAULT_MODES };
    this.resetSeen = true;
  }

  private startString(kind: string): void {
    this.state = "string";
    this.stringKind = kind;
    this.string = "";
    this.stringOverflow = false;
  }

  private collect(char: string): void {
    // only an OSC 52 is ever read: anything else is skipped without holding it
    if (this.stringKind !== "]" || this.stringOverflow) return;
    if (this.string.length < 3 && !"52;".startsWith(this.string + char)) {
      this.stringOverflow = true;
      return;
    }
    if (this.string.length >= MAX_STRING) {
      this.stringOverflow = true;
      this.string = "";
      return;
    }
    this.string += char;
  }

  private endString(): void {
    this.state = "ground";
    if (this.stringKind === "]" && !this.stringOverflow && this.string.startsWith("52;")) {
      this.clipboard = { seq: (this.clipboard?.seq ?? 0) + 1, payload: this.string.slice(3) };
    }
    this.string = "";
  }
}
