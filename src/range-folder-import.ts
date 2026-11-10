import type { DbItem, DbGroup } from "./db";

export type FolderEntry = { path: string[]; isGroup: boolean; value?: string };

// Import as a new group, preserving all descendants and never overwriting a
// saved range. Another import of the same folder receives a numbered root.
export const planFolderImport = (
  entries: FolderEntry[],
  parent: string[],
  existing: (DbItem | DbGroup)[]
): { root: string[]; items: (DbItem | DbGroup)[] } => {
  const source = entries[0];
  if (!source?.isGroup || source.path.length !== 1)
    throw new Error("Invalid folder data");
  const occupied = new Set(existing.map((item) => item.pathKey));
  const base = source.path[0];
  let name = base;
  let suffix = 2;
  while (occupied.has(JSON.stringify([...parent, name])))
    name = `${base} (${suffix++})`;
  const root = [...parent, name];
  const seen = new Map<string, boolean>();
  const items = entries.map((entry): DbItem | DbGroup => {
    if (
      !entry.path.length ||
      entry.path[0] !== base ||
      entry.path.some((part) => typeof part !== "string" || !part.trim()) ||
      (!entry.isGroup && typeof entry.value !== "string")
    )
      throw new Error("Invalid folder data");
    const sourceKey = JSON.stringify(entry.path);
    if (
      seen.has(sourceKey) ||
      (entry.path.length > 1 &&
        !seen.get(JSON.stringify(entry.path.slice(0, -1))))
    )
      throw new Error("Invalid folder hierarchy");
    seen.set(sourceKey, entry.isGroup);
    const path = [...root, ...entry.path.slice(1)];
    const pathKey = JSON.stringify(path);
    return entry.isGroup
      ? { path, pathKey, isGroup: 1 }
      : { path, pathKey, isGroup: 0, value: entry.value };
  });
  return { root, items };
};
