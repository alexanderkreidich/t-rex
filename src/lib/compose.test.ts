import { describe, expect, it } from "bun:test";

import { composerMessage, composerPayload, submitNote } from "./compose.ts";

describe("composerMessage and submitNote", () => {
  it("keeps the message as written for agent.prompt: inner newlines stay, the composer's own trailing ones go", () => {
    expect(composerMessage("line one\r\nline two\n\n")).toBe("line one\nline two");
  });

  it("keeps pasted Markdown, blank lines and code indentation in one submitted message", () => {
    const message = "# Reply\n\n- first\n- second\n\n```ts\n  run();\n```";
    expect(composerMessage(message.replaceAll("\n", "\r\n"))).toBe(message);
    expect(composerPayload(message, true)).toBe("\u001b[200~" + message.replaceAll("\n", "\r") + "\u001b[201~");
  });

  it("says why a line did not go, and never claims a lost one was sent", () => {
    expect(submitNote("agent_blocked", "x")).toBe("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
    expect(submitNote("read_only", "x")).toBe("Not sent: this view only watches the pane.");
    expect(submitNote("submit_timeout", "x")).toMatch(/^Not sent: .*nothing was typed/);
    expect(submitNote("disconnected", "x")).toMatch(/^Not confirmed: .*Check the terminal/);
    expect(submitNote("pane_not_found", "pane w1:p9 not found")).toBe("Not sent: pane w1:p9 not found");
  });

  it("names a send dropped before it left, and the held input it waits behind", () => {
    expect(submitNote("not_transmitted", "the connection dropped before this message was sent")).toBe("Not sent: the connection dropped before this message left. Send it again.");
    expect(submitNote("held_input", "x")).toBe("Not sent: send or discard the held input first.");
  });
});

describe("composerPayload", () => {
  it("bracketed mode wraps the text as one paste, without the submit", () => {
    expect(composerPayload("hello", true)).toBe("\u001b[200~hello\u001b[201~");
  });

  it("bracketed mode keeps inner newlines literal to the TUI input box", () => {
    expect(composerPayload("line one\nline two", true)).toBe("\u001b[200~line one\rline two\u001b[201~");
  });

  it("normalizes CRLF and lone CR to the pty newline CR", () => {
    expect(composerPayload("a\r\nb\rc", true)).toBe("\u001b[200~a\rb\rc\u001b[201~");
  });

  it("drops trailing newlines: the submit CR belongs to the composer, not the text", () => {
    expect(composerPayload("cmd\n\n", true)).toBe("\u001b[200~cmd\u001b[201~");
    expect(composerPayload("cmd\n\n", false)).toBe("cmd");
  });

  it("plain mode uses classic paste semantics: every newline submits its own line", () => {
    expect(composerPayload("git status\ngit diff", false)).toBe("git status\rgit diff");
  });

  it("plain mode sends a single line; the submit CR goes on its own", () => {
    expect(composerPayload("git status", false)).toBe("git status");
  });

  it("empty text types nothing; its submit still goes on its own", () => {
    expect(composerPayload("", true)).toBe("\u001b[200~\u001b[201~");
    expect(composerPayload("", false)).toBe("");
  });
});
