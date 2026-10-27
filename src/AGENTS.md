# src/

- The auth token lives only in the HttpOnly cookie, never in localStorage or sessionStorage.
- A new setting needs its default and type check in `sanitizeSettings`, or it is silently dropped.
- Secret input stays in the DOM input only: never React state, a draft, a queue or a retry.
- Import only types from `shared/protocol.ts`: importing a value reads the server's environment.
- Before a new UI feature or a UI fix, read the root AGENTS.md's UX and motion rules and the
  skill they name. Name the reference the design follows (Ghostty, Zed, Warp, Arc, Linear) in the
  PR. Pixels are not copied; adapted code is credited in THIRD_PARTY_NOTICES.md.
