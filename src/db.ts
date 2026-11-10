import Dexie, { Table } from "dexie";
import { ConfigValue1, migrateConfig1to2 } from "./db-migration";

export type DbItem = {
  id?: number;
  path: string[];
  pathKey: string;
  isGroup: 0;
  value: unknown;
};

export type DbGroup = {
  id?: number;
  path: string[];
  pathKey: string;
  isGroup: 1;
};

type LegacyEntry = {
  name0: string;
  name1: string;
  name2: string;
  name3: string;
  isGroup: 0 | 1;
  value?: unknown;
};

export const legacyPath = (item: LegacyEntry): string[] => {
  const names = [item.name0, item.name1, item.name2, item.name3];
  const end = names.indexOf("");
  return end < 0 ? names : names.slice(0, end);
};

export const validPath = (path: unknown): path is string[] =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.every((name) => typeof name === "string" && name.trim() !== "");

export const withinPath = (path: string[], parent: string[]): boolean =>
  path.length >= parent.length && parent.every((name, i) => path[i] === name);

export class DesktopPostflopDB extends Dexie {
  public ranges!: Table<DbItem | DbGroup, number>;
  public configurations!: Table<DbItem | DbGroup, number>;

  public constructor(name = "DesktopPostflopDB") {
    super(name);

    this.version(1).stores({
      ranges: "++id, [name0+name1+name2+name3+isGroup]",
      configurations: "++id, [name0+name1+name2+name3+isGroup]",
    });

    this.version(2)
      .stores({
        ranges: "++id, [name0+name1+name2+name3+isGroup]",
        configurations: "++id, [name0+name1+name2+name3+isGroup]",
      })
      .upgrade((tx) => {
        return tx
          .table("configurations")
          .toCollection()
          .modify((item: LegacyEntry) => {
            if (!item.isGroup) {
              item.value = migrateConfig1to2(item.value as ConfigValue1);
            }
          });
      });

    // Preserve existing ranges/configurations while removing the four-level limit.
    this.version(3)
      .stores({
        ranges: "++id, &pathKey, isGroup",
        configurations: "++id, &pathKey, isGroup",
      })
      .upgrade(async (tx) => {
        for (const store of ["ranges", "configurations"]) {
          await tx
            .table(store)
            .toCollection()
            .modify((item) => {
              item.path = legacyPath(item);
              item.pathKey = JSON.stringify(item.path);
              delete item.name0;
              delete item.name1;
              delete item.name2;
              delete item.name3;
            });
        }
      });
  }
}

const db = new DesktopPostflopDB();

export const getArray = async (store: string) => {
  return (await db.table(store).toArray()) as (DbItem | DbGroup)[];
};

// Validate the entire batch before writing. A failed import leaves the library intact.
export const bulkAdd = async (store: string, items: (DbItem | DbGroup)[]) => {
  try {
    const table = db.table(store);
    return await db.transaction("rw", table, async () => {
      const existing = new Map<string, DbItem | DbGroup>(
        (await table.toArray()).map((item) => [item.pathKey, item])
      );
      const normalized = items.map((item) => {
        const entry = {
          ...item,
          path: [...item.path],
          pathKey: JSON.stringify(item.path),
        };
        delete entry.id;
        return entry;
      });
      for (const item of normalized) {
        if (!validPath(item.path) || existing.has(item.pathKey)) return false;
        existing.set(item.pathKey, item);
      }
      for (const item of normalized) {
        if (
          item.path.length > 1 &&
          existing.get(JSON.stringify(item.path.slice(0, -1)))?.isGroup !== 1
        ) {
          return false;
        }
      }
      await table.bulkAdd(normalized);
      return true;
    });
  } catch {
    return false;
  }
};

export const addItem = (store: string, item: DbItem) => bulkAdd(store, [item]);
export const addGroup = (store: string, item: DbGroup) =>
  bulkAdd(store, [item]);

export const overwriteItem = async (store: string, item: DbItem) => {
  try {
    const table = db.table(store);
    return await db.transaction("rw", table, async () => {
      const current = await table
        .where("pathKey")
        .equals(JSON.stringify(item.path))
        .first();
      if (!current || current.isGroup !== 0) return false;
      await table.update(current.id, { value: item.value });
      return true;
    });
  } catch {
    return false;
  }
};

export const renameItem = async (
  store: string,
  item: DbItem | DbGroup,
  newName: string
) => {
  if (!validPath(item.path) || newName.trim() === "") return false;
  try {
    const table = db.table(store);
    return await db.transaction("rw", table, async () => {
      const current = await table
        .where("pathKey")
        .equals(JSON.stringify(item.path))
        .first();
      if (!current || current.isGroup !== item.isGroup) return false;
      const newPath = [...item.path.slice(0, -1), newName];
      const key = JSON.stringify(newPath);
      if (key === current.pathKey) return true;
      if (await table.where("pathKey").equals(key).count()) return false;
      const entries: (DbItem | DbGroup)[] = await table
        .filter((entry) =>
          item.isGroup
            ? withinPath(entry.path, item.path)
            : entry.pathKey === current.pathKey
        )
        .toArray();
      await table.bulkPut(
        entries.map((entry) => {
          const path = [...newPath, ...entry.path.slice(item.path.length)];
          return { ...entry, path, pathKey: JSON.stringify(path) };
        })
      );
      return true;
    });
  } catch {
    return false;
  }
};

export const deleteItem = async (store: string, item: DbItem | DbGroup) => {
  try {
    const table = db.table(store);
    return await db.transaction("rw", table, async () => {
      const key = JSON.stringify(item.path);
      const current = await table.where("pathKey").equals(key).first();
      if (!current || current.isGroup !== item.isGroup) return false;
      await table
        .filter((entry) =>
          item.isGroup
            ? withinPath(entry.path, item.path)
            : entry.pathKey === key
        )
        .delete();
      return true;
    });
  } catch {
    return false;
  }
};
