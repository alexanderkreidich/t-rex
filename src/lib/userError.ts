import { ApiError } from "./api.ts";
import { t } from "./i18n.ts";

export interface UserError {
  message: string;
  /** the server's or the browser's own words, kept visible and selectable; null when they add nothing */
  detail: string | null;
}

/** How a request failed, as far as the browser can tell. */
export type FailureKind = "signed-out" | "gone" | "changed" | "slow" | "unreachable" | "refused" | "unknown";

/** What fetch rejects with when the request never got an answer: Chrome, Firefox and Safari words. */
const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed/i;

/** A failure the server names by a code of its own, whatever the status: the sentence is the next step on the PC. */
const SENTENCE_BY_CODE: Readonly<Record<string, () => string>> = {
  // server/preferences.ts: its state folder refused the write, so no browser can save a shared setting
  preferences_unwritable: () => t("The server cannot save settings: check that its state folder is writable."),
};

/** The server's own words when herdr itself is away (server/herdr/client.ts names the socket it tried). */
const HERDR_AWAY = /cannot reach herdr/i;

function kindOf(cause: unknown): FailureKind {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return "signed-out";
    if (cause.status === 404) return "gone";
    if (cause.status === 409) return "changed";
    if (cause.status === 408 || cause.status === 504) return "slow";
    if (cause.status >= 500) return "refused";
    return "unknown";
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) return "slow";
  if (cause instanceof TypeError && NETWORK_FAILURE.test(cause.message)) return "unreachable";
  return "unknown";
}

function ownWords(cause: unknown): string {
  return cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);
}

const SENTENCE: Record<FailureKind, () => string> = {
  "signed-out": () => t("This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices."),
  gone: () => t("That item no longer exists on the PC. Refresh and try again."),
  changed: () => t("It changed on the PC while you were acting. Check it and try again."),
  slow: () => t("The PC took too long to answer. Try again."),
  unreachable: () => t("Can't reach the PC. Check your connection, then try again."),
  refused: () => t("The PC could not do that. Try again; if it keeps failing, restart T-Rex on the PC."),
  unknown: () => t("Something went wrong. Try again."),
};

/** A plain sentence for a failure, with what the server or the browser said kept beside it. */
export function userErrorMessage(cause: unknown): UserError {
  const coded = cause instanceof ApiError && cause.code !== null && Object.hasOwn(SENTENCE_BY_CODE, cause.code) ? SENTENCE_BY_CODE[cause.code] : undefined;
  const message = coded?.() ?? SENTENCE[kindOf(cause)]();
  const original = ownWords(cause);
  return { message, detail: original.trim() === "" || original === message ? null : original };
}

/**
 * Whether the server's words say herdr itself is away on its PC: nothing in this browser helps, so
 * the sidebar's state line and the header's pill add the step to take there.
 */
export function saysHerdrAway(words: string): boolean {
  return HERDR_AWAY.test(words);
}

