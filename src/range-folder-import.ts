import type { DbItem, DbGroup } from "./db";

export type FolderEntry = { path: string[]; isGroup: boolean; value?: string };

// Merge existing folder groups when requested, so reimporting repairs missing
// ranges. Existing files with different contents are preserved under a new name.
export const planFolderImport = (
  entries: FolderEntry[],
  parent: string[],
  existing: (DbItem | DbGroup)[],
  mergeExisting = false
): { root: string[]; items: (DbItem | DbGroup)[]; ranges: DbItem[] } => {
  const source = entries[0];
  if (!source?.isGroup || source.path.length !== 1)
    throw new Error("Invalid folder data");
  const occupied = new Map(existing.map((item) => [item.pathKey, item]));
  const base = source.path[0];
  let name = base;
  let suffix = 2;
  while (
    occupied.has(JSON.stringify([...parent, name])) &&
    !(
      mergeExisting &&
      occupied.get(JSON.stringify([...parent, name]))?.isGroup === 1
    )
  )
    name = `${base} (${suffix++})`;
  const root = [...parent, name];
  const seen = new Map<string, boolean>();
  const items: (DbItem | DbGroup)[] = [];
  const ranges: DbItem[] = [];
  for (const entry of entries) {
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
    let path = [...root, ...entry.path.slice(1)];
    let pathKey = JSON.stringify(path);
    if (entry.isGroup) {
      const previous = occupied.get(pathKey);
      if (previous?.isGroup === 0)
        throw new Error(
          `Cannot import folder "${path.join("/")}" over an existing range`
        );
      if (!previous) {
        const group: DbGroup = { path, pathKey, isGroup: 1 };
        items.push(group);
        occupied.set(pathKey, group);
      }
      continue;
    }
    const originalName = path[path.length - 1];
    const extension = originalName.toLowerCase().endsWith(".txt")
      ? originalName.slice(-4)
      : "";
    const stem = extension ? originalName.slice(0, -4) : originalName;
    let number = 2;
    let previous = occupied.get(pathKey);
    while (
      previous &&
      (previous.isGroup === 1 || previous.value !== entry.value)
    ) {
      path = [...path.slice(0, -1), `${stem} (${number++})${extension}`];
      pathKey = JSON.stringify(path);
      previous = occupied.get(pathKey);
    }
    const range: DbItem = { path, pathKey, isGroup: 0, value: entry.value };
    ranges.push(range);
    if (!previous) {
      items.push(range);
      occupied.set(pathKey, range);
    }
  }
  return { root, items, ranges };
};
