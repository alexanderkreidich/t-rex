import { describe, expect, it } from "bun:test";
import { pathParts } from "./filePaths.ts";

describe("pathParts", () => {
  it("splits a path into its folder, the name's stem and its extension", () => {
    expect(pathParts("/a/b/c.md")).toEqual({ folder: "/a/b", stem: "c", extension: ".md" });
    expect(pathParts("C:\\repo\\a.tar.gz")).toEqual({ folder: "C:\\repo", stem: "a.tar", extension: ".gz" });
    expect(pathParts("~/notes.txt")).toEqual({ folder: "~", stem: "notes", extension: ".txt" });
  });

  it("keeps the root as the folder of a file directly in it", () => {
    expect(pathParts("/c.md").folder).toBe("/");
    expect(pathParts("C:\\c.md").folder).toBe("C:\\");
  });

  it("has no folder for a bare name", () => {
    expect(pathParts("notes.txt")).toEqual({ folder: "", stem: "notes", extension: ".txt" });
  });

  it("gives a dotfile, a name without a dot and a trailing dot no extension", () => {
    expect(pathParts("/x/.gitignore")).toEqual({ folder: "/x", stem: ".gitignore", extension: "" });
    expect(pathParts("/x/Dockerfile")).toEqual({ folder: "/x", stem: "Dockerfile", extension: "" });
    expect(pathParts("/x/name.")).toEqual({ folder: "/x", stem: "name.", extension: "" });
  });
});
