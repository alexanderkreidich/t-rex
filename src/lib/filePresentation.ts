
export type FilePresentation = "panel" | "popup";
/** where a file opens until its header button moves it (Settings → Chat → File viewer): popup first by default */
export const FILE_OPEN_TARGETS = ["popup", "panel"] as const satisfies readonly FilePresentation[];

