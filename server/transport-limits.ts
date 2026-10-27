/**
 * How much a WebSocket may hold queued before its client is taken for gone. A synced client
 * (server/ssp/sync.ts) waits for its queue to drain and skips to the current screen; these bound
 * only what a connection may pile up anyway: a raw stream's older page, a relay.
 */
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
/** how long a connection may stay at OUTPUT_HIGH_BYTES or more before it is closed with 4008 */
export const OUTPUT_STALL_MS = 2000;
