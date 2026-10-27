import { describe, expect, it } from "bun:test";
import { fileUriPath, isWebLink, webLinkAt } from "./terminalLinks.ts";

describe("isWebLink", () => {
  it("opens http and https addresses, in any case", () => {
    for (const uri of ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM"]) {
      expect(isWebLink(uri)).toBe(true);
    }
  });

  it("refuses every other scheme a crafted terminal line could carry", () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd", "ws://example.com", "//example.com", "example.com", " https://example.com"]) {
      expect(isWebLink(uri)).toBe(false);
    }
  });
});

describe("fileUriPath", () => {
  it("rejects malformed or nonlocal file URIs", () => {
    for (const uri of ["file://host/tmp/a.png", "file:///tmp/%zz", "file:///tmp/%00", "https://example.com/a.png"])
      expect(fileUriPath(uri)).toBeNull();
    // a network share on a Windows PC, however its second separator is written, and a control character
    for (const uri of ["file:////attacker.example/share/doc.txt", "file:///%2Fattacker.example/share/doc.txt", "file:///%5C%5Cattacker.example/share", "file:///tmp/a.md\u0000", "file:///tmp/a\u001b.md"])
      expect(fileUriPath(uri)).toBeNull();
    // a control character written encoded is refused too: the server trimmed `%0A` and opened /etc/hosts
    for (const uri of ["file:///etc/hosts%0A", "file:///tmp/a%1B.md", "file:///tmp/a%7F.md"]) expect(fileUriPath(uri)).toBeNull();
    // an apostrophe belongs to the name
    expect(fileUriPath("file:///tmp/Bob's-notes.md")).toBe("/tmp/Bob's-notes.md");
    // a Windows drive path loses the slash a URI puts before it
    expect(fileUriPath("file:///C:/Users/Alice/readme.md")).toBe("C:/Users/Alice/readme.md");
  });
});

describe("webLinkAt", () => {
  const cells = (text: string): string[] => [...text];
  it("finds the address under a column, without the punctuation that ends the sentence", () => {
    const row = cells("see https://example.test/621, then (https://a.test/x?y=1).");
    expect(webLinkAt(row, 10)).toBe("https://example.test/621");
    // its last column is the 1, and the comma after it is not the address
    expect(webLinkAt(row, 27)).toBe("https://example.test/621");
    expect(webLinkAt(row, 28)).toBeNull();
    expect(webLinkAt(row, 40)).toBe("https://a.test/x?y=1");
    expect(webLinkAt(row, 2)).toBeNull();
  });

  it("counts columns, not characters: a wide character before the address keeps its two", () => {
    expect(webLinkAt(["界", "", " ", ...cells("http://a.test")], 5)).toBe("http://a.test");
    expect(webLinkAt(["界", "", " ", ...cells("http://a.test")], 1)).toBeNull();
  });

  it("takes only http and https", () => {
    expect(webLinkAt(cells("ftp://a.test file:///etc javascript:alert(1)"), 2)).toBeNull();
  });
});
