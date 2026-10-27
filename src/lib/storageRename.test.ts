import { expect, it } from "bun:test";
import { renameKeys } from "./storageRename.ts";

function storage(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

it("moves the old name's keys to t-rex's and leaves a newer value and other keys alone", () => {
  const store = storage({
    "herdr-web-ui:settings": '{"theme":"nord"}',
    "herdr-web-ui:terminal-draft:local:p1": "git push",
    "herdr-web-ui:split": "old",
    "t-rex:split": "new",
    "other:key": "kept",
  });
  renameKeys(store);
  expect(Object.fromEntries(store.data)).toEqual({
    "t-rex:settings": '{"theme":"nord"}',
    "t-rex:terminal-draft:local:p1": "git push",
    "t-rex:split": "new",
    "other:key": "kept",
  });
});
