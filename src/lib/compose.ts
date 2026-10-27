/**
 * Input line -> pty byte shaping. The input line sends "one line", but the pane's program
 * defines what a safe submission is, so the payload follows the pane's own bracketed-paste
 * mode (term.modes.bracketedPasteMode):
 * - mode on (agent TUIs): the text goes out as ONE bracketed paste - newlines stay
 *   literal inside it - and a bare CR submits it, exactly like paste+Enter.
 * - mode off (plain shell): classic paste semantics - every newline submits its own
 *   line, and the trailing CR runs the last one.
 * Pure logic, DOM-free, so the policy is unit-testable (see compose.test.ts).
 */

import { t } from "./i18n.ts";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** A line as written: trailing newlines are the input line's, not the text's; CRLF reads as one newline. */
export function composerMessage(text: string): string {
  return text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
}

/** The text a line types, without its submit (HerdrSocket.submit adds the Enter). */
export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = composerMessage(text).replace(/\n/g, "\r");
  return bracketedPaste ? PASTE_START + body + PASTE_END : body;
}

/** `agent`: the pane's agent, which names the input an input_draft refusal is about (Claude Code's when unknown) */
export function submitNote(code: string, message: string, agent?: string | null): string {
  if (code === "submit_partial") return t("Not confirmed: the terminal draft was cleared or may have changed. Your message stayed here. Check the terminal before sending again.");
  if (code === "agent_blocked") return t("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
  if (code === "read_only") return t("Not sent: this view only watches the pane.");
  if (code === "held_input") return t("Not sent: send or discard the held input first.");
  if (code === "input_draft" && agent === "hermes") return t("Not sent: Hermes' input in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "input_draft") return t("Not sent: Claude Code's input box in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "submit_timeout") return t("Not sent: it waited too long behind an earlier message, and nothing was typed. Send it again.");
  if (code === "not_transmitted") return t("Not sent: the connection dropped before this message left. Send it again.");
  if (code === "disconnected" || code === "timeout") return t("Not confirmed: the pane did not confirm this message. Check the terminal before sending it again.");
  return t("Not sent: {message}", { message });
}
