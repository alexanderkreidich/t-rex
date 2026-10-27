/**
 * The input line's submit (ClientMessage `submit`): its text typed into the pane like the keyboard,
 * then Enter after a gap, in the pane's lane behind whatever was typed before it. Every submit is
 * answered, so the input line keeps its text until it hears back.
 */
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import type { ClientMessage } from "../../shared/protocol.ts";
import { HerdrError, paneSendKeys, paneSendText } from "../herdr/client.ts";
import { mirrorInput } from "../mirror-input.ts";
import { paneAgentOf } from "../pane-context.ts";

/**
 * A line whose last word is an `@file` mention leaves the agent's file suggestions open over it,
 * and the Enter after the paste takes the suggestion instead of sending: the line stays in the
 * input box (Claude Code 2.1.295, #404). A space after the mention closes them first; a payload
 * already in bracketed-paste markers gets it inside them.
 */
export const closeMention = (text: string): string => {
  const open = text.startsWith("\u001b[200~") ? "\u001b[200~" : "";
  const close = open && text.endsWith("\u001b[201~") ? "\u001b[201~" : "";
  const body = text.slice(open.length, text.length - close.length);
  return /(?:^|\s)@\S+$/.test(body) ? `${open}${body} ${close}` : text;
};

export function createSubmit({ options, attachments, serialize, lastTyped, terminalAttach, authorizeSocket, SUBMIT_DEADLINE_MS, TYPED_SETTLE_MS, SUBMIT_DELAY_MS }: {
  options: { submitDeadlineMs?: number; submitDelayMs?: number };
  attachments: ReadonlyMap<string, { readonly held?: boolean }>;
  serialize: <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;
  lastTyped: Map<string, number>;
  terminalAttach: () => Promise<boolean>;
  authorizeSocket: (client: Client) => void;
  SUBMIT_DEADLINE_MS: number;
  TYPED_SETTLE_MS: number;
  SUBMIT_DELAY_MS: number;
}) {
  /**
   * Types `payload` (the line shaped for the pane's paste mode) and its own Enter after it: arriving
   * in the same chunk as the paste, a TUI still busy with it could take the Enter for a newline and
   * leave the line in its input box. Done here rather than in the browser, the gap survives a jittery
   * connection and the Enter still goes when the phone locks.
   */
  async function submitLine(paneId: string, payload: string, arrivedAt: number, authorize: () => void): Promise<void> {
    const inTime = (): void => {
      authorize();
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) {
        throw new HerdrError("submit_timeout", "the line waited too long behind earlier input; nothing was typed");
      }
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    // fixed wait: herdr holds a lone ESC typed through the attach pty and says nothing when it lets go
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
    // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
    // asked only for such a block, so a one-line send never waits on it.
    const shaped = await mirrorInput(closeMention(payload), async () => await terminalAttach() ? null : await paneAgentOf(paneId));
    inTime();
    await paneSendText(paneId, shaped);
    // fixed wait: a TUI busy with the paste takes an Enter in the same chunk for a newline (SUBMIT_DELAY_MS)
    await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
    authorize();
    await paneSendKeys(paneId, ["Enter"]);
  }

  return {
    async submit(client: Client, message: Extract<ClientMessage, { type: "submit" }>): Promise<void> {
      const result = (ok: boolean, code?: string, text?: string) => send(client, {
        type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code, message: text } : {}),
      });
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
        || typeof message.text !== "string" || typeof message.payload !== "string") {
        send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
        return;
      }
      if (connectionOf(client).mode === "observe") {
        result(false, "read_only", "this connection is in observe mode");
        return;
      }
      // another web bridge has this pane's terminal: its user types there, not this one
      if (attachments.get(message.pane_id)?.held) {
        result(false, "attach_held", ATTACH_HELD_MESSAGE);
        return;
      }
      const arrivedAt = Date.now();
      try {
        await serialize(message.pane_id, () => {
          // held while this waited its turn (the attach was refused after the check above)
          if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
          return submitLine(message.pane_id, message.payload, arrivedAt, () => authorizeSocket(client));
        });
        result(true);
      } catch (error) {
        result(false, error instanceof HerdrError ? error.code : "submit_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
