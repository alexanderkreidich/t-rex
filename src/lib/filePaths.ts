/**
 * A path in the three parts a viewer shows apart: the folder (the root itself for a file in it,
 * empty for a bare name), and the name as stem and extension, so a long name can be cut inside the
 * stem and still show its type. A dotfile (`.gitignore`) or a name ending in a dot has no extension.
 */
export function pathParts(path: string): { folder: string; stem: string; extension: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(cut + 1);
  const head = cut < 0 ? "" : path.slice(0, cut);
  // "/c.md" and "C:\c.md" live in the root: keep its separator, or it reads as a relative folder
  const folder = cut >= 0 && (head === "" || /^[A-Za-z]:$/.test(head)) ? path.slice(0, cut + 1) : head;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? { folder, stem: name.slice(0, dot), extension: name.slice(dot) }
    : { folder, stem: name, extension: "" };
}
