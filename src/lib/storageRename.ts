/**
 * Before the app was named T-Rex its keys in localStorage and sessionStorage started with
 * `herdr-web-ui:`. Each moves once to the same name under `t-rex:` (settings, drafts, layout), before
 * any module reads one: main.tsx imports this first. A value already under the new name wins.
 */
const BEFORE = "herdr-web-ui:";
const NOW = "t-rex:";

export function renameKeys(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(BEFORE)) keys.push(key);
  }
  for (const key of keys) {
    const value = storage.getItem(key);
    const renamed = NOW + key.slice(BEFORE.length);
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
    storage.removeItem(key);
  }
}

if (typeof window !== "undefined") {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try { renameKeys(window[name]); } catch { /* storage this page may not use: nothing to move */ }
  }
}
