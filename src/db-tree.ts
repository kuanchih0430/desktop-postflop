import type { DbItem, DbGroup } from "./db";

export type Item = {
  isGroup: false;
  path: string[];
  pathStr: string;
  value: unknown;
  isEditing: boolean;
};

export type Group = {
  isGroup: true;
  path: string[];
  pathStr: string;
  opened: boolean;
  isEditing: boolean;
  items: (Item | Group)[];
};

export const buildTree = (entries: (DbItem | DbGroup)[]): (Item | Group)[] => {
  const roots: (Item | Group)[] = [];
  const children = new Map<string, (Item | Group)[]>([["[]", roots]]);
  const ordered = [...entries].sort((a, b) => a.path.length - b.path.length);
  for (const entry of ordered) {
    const path = [...entry.path];
    const pathStr = JSON.stringify(path);
    const siblings = children.get(JSON.stringify(path.slice(0, -1)));
    if (!siblings || path.length === 0)
      throw new Error("Missing library group");
    const common = { path, pathStr, isEditing: false };
    if (entry.isGroup) {
      const items: (Item | Group)[] = [];
      siblings.push({
        ...common,
        isGroup: true,
        opened: path.length === 1,
        items,
      });
      children.set(pathStr, items);
    } else {
      siblings.push({ ...common, isGroup: false, value: entry.value });
    }
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) =>
        Number(b.isGroup) - Number(a.isGroup) ||
        a.path[a.path.length - 1].localeCompare(
          b.path[b.path.length - 1],
          undefined,
          { numeric: true }
        )
    );
  }
  return roots;
};
