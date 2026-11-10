const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");
require("fake-indexeddb/auto");
const Dexie = require("dexie");

// Run the actual application modules against IndexedDB, including Dexie upgrades.
const modules = new Map();
function loadTs(filename) {
  const absolute = path.resolve(__dirname, "..", filename);
  if (modules.has(absolute)) return modules.get(absolute);
  const exports = {};
  modules.set(absolute, exports);
  const localRequire = createRequire(absolute);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInThisContext(`(function(require, exports) { ${code}\n})`, {
    filename: absolute,
  })(
    (name) =>
      name.startsWith(".")
        ? loadTs(
            path.relative(
              path.resolve(__dirname, ".."),
              path.resolve(path.dirname(absolute), `${name}.ts`)
            )
          )
        : localRequire(name),
    exports
  );
  return exports;
}

const Db = loadTs("src/db.ts");
const { buildTree } = loadTs("src/db-tree.ts");
const { planFolderImport } = loadTs("src/range-folder-import.ts");
const legacySchema = {
  ranges: "++id, [name0+name1+name2+name3+isGroup]",
  configurations: "++id, [name0+name1+name2+name3+isGroup]",
};
const source = fs
  .readFileSync(path.join(__dirname, "fixtures/pio-range.txt"), "utf8")
  .trim();
const record = (names, isGroup, value) => ({
  path: names,
  pathKey: JSON.stringify(names),
  isGroup,
  ...(isGroup ? {} : { value }),
});
const legacy = (names, isGroup, value) => ({
  name0: names[0],
  name1: names[1] ?? "",
  name2: names[2] ?? "",
  name3: names[3] ?? "",
  isGroup,
  ...(isGroup ? {} : { value }),
});

let folderEntries;
let importedRoot;
let deepest;

test("upgrades existing v2 ranges and configurations without losing paths or values", async () => {
  const previous = new Dexie("DesktopPostflopDB");
  previous.version(2).stores(legacySchema);
  await previous
    .table("ranges")
    .bulkAdd([
      legacy(["Test"], 1),
      legacy(["Test", "Empty"], 1),
      legacy(["Test", "Range"], 0, source),
      legacy(["Top"], 0, "AA:0.5"),
    ]);
  await previous
    .table("configurations")
    .add(legacy(["Saved config"], 0, { startingPot: 45, board: [0, 1, 2] }));
  previous.close();
  const ranges = await Db.getArray("ranges");
  assert.equal(ranges.length, 4);
  assert.equal(
    ranges.find((entry) => entry.pathKey === '["Test","Range"]').value,
    source
  );
  assert.ok(
    ranges.every((entry) => Array.isArray(entry.path) && !("name0" in entry))
  );
  const configurations = await Db.getArray("configurations");
  assert.deepEqual(configurations[0].value, {
    startingPot: 45,
    board: [0, 1, 2],
  });
  assert.deepEqual(configurations[0].path, ["Saved config"]);
});

test("v1 upgrade still migrates configurations before adopting arbitrary paths", async () => {
  const previous = new Dexie("RangeFolderLegacyV1");
  previous.version(1).stores(legacySchema);
  const value = {
    startingPot: 20,
    effectiveStack: 100,
    addAllInThreshold: 150,
    forceAllInThreshold: 10,
    adjustLastTwoBetSizes: 0,
  };
  for (const player of ["oop", "ip"])
    for (const street of ["Flop", "Turn", "River"]) {
      value[`${player}${street}BetStr`] = "50";
      value[`${player}${street}RaiseStr`] = "2.5x";
    }
  await previous.table("configurations").add(legacy(["Config"], 0, value));
  await previous.table("ranges").add(legacy(["Range"], 0, source));
  previous.close();
  const current = new Db.DesktopPostflopDB("RangeFolderLegacyV1");
  const config = await current.configurations.toArray();
  assert.equal(config[0].value.oopFlopBet, "50");
  assert.equal(config[0].value.rakePercent, 0);
  assert.deepEqual(config[0].path, ["Config"]);
  assert.equal((await current.ranges.toArray())[0].value, source);
  await current.delete();
});

test("imports twelve nested groups, empty folders and repeated filenames", async () => {
  const names = [
    "PioRanges_nlhe_100bb_3x_NL200",
    "LJ2bets",
    "HJfolds",
    "COfolds",
    "Bcalls",
    "SB3bets",
    "BBfolds",
    "LJ4bets",
    "Bcalls",
    "SB5bets",
    "LJcalls",
    "空群組",
  ];
  folderEntries = [];
  for (let i = 1; i <= names.length; i++)
    folderEntries.push({ path: names.slice(0, i), isGroup: true });
  folderEntries.push({
    path: [names[0], "LJ_raise.txt"],
    isGroup: false,
    value: source,
  });
  folderEntries.push({
    path: [...names.slice(0, -1), "LJ_raise.txt"],
    isGroup: false,
    value: "KK:0.25",
  });
  const planned = planFolderImport(
    folderEntries,
    [],
    await Db.getArray("ranges")
  );
  assert.equal(await Db.bulkAdd("ranges", planned.items), true);
  importedRoot = planned.root;
  deepest = [...names.slice(0, -1), "LJ_raise.txt"];
  const tree = buildTree((await Db.getArray("ranges")).reverse());
  let group = tree.find(
    (entry) => entry.pathStr === JSON.stringify(importedRoot)
  );
  for (const name of names.slice(1)) {
    group = group.items.find((entry) => entry.path.at(-1) === name);
    assert.ok(group?.isGroup);
  }
  assert.deepEqual(group.items, []);
  const sameNames = (await Db.getArray("ranges")).filter(
    (entry) => entry.path.at(-1) === "LJ_raise.txt"
  );
  assert.equal(sameNames.length, 2);
  assert.notEqual(sameNames[0].pathKey, sameNames[1].pathKey);
});

test("repeat folder imports get numbered roots and honor a selected parent group", async () => {
  const existing = await Db.getArray("ranges");
  const repeated = planFolderImport(folderEntries, [], existing);
  assert.equal(repeated.root[0], `${importedRoot[0]} (2)`);
  assert.equal(await Db.bulkAdd("ranges", repeated.items), true);
  const nested = planFolderImport(
    folderEntries,
    ["Test"],
    await Db.getArray("ranges")
  );
  assert.deepEqual(nested.root, ["Test", importedRoot[0]]);
  assert.equal(await Db.bulkAdd("ranges", nested.items), true);
  assert.equal(
    (await Db.getArray("ranges")).find(
      (entry) => entry.pathKey === '["Test","Range"]'
    ).value,
    source
  );
});

test("invalid, duplicate and orphaned batches leave the database unchanged", async () => {
  const before = await Db.getArray("ranges");
  assert.equal(
    await Db.bulkAdd("ranges", [record(["New"], 1), record(["Top"], 0, "KK")]),
    false
  );
  assert.deepEqual(await Db.getArray("ranges"), before);
  assert.equal(
    await Db.bulkAdd("ranges", [record(["Missing", "Child"], 0, "AA")]),
    false
  );
  assert.deepEqual(await Db.getArray("ranges"), before);
  assert.equal(
    await Db.bulkAdd("ranges", [record(["Dup"], 1), record(["Dup"], 0, "AA")]),
    false
  );
  assert.deepEqual(await Db.getArray("ranges"), before);
  assert.throws(() =>
    planFolderImport(
      [
        { path: ["Root"], isGroup: true },
        { path: ["Root", "Missing", "Child"], isGroup: false, value: "AA" },
      ],
      [],
      []
    )
  );
});

test("deep overwrite, subtree rename and deletion preserve neighboring groups", async () => {
  assert.equal(
    await Db.overwriteItem("ranges", record(deepest, 0, "AA:0.5")),
    true
  );
  let records = await Db.getArray("ranges");
  assert.equal(
    records.find((entry) => entry.pathKey === JSON.stringify(deepest)).value,
    "AA:0.5"
  );
  assert.equal(
    records.find(
      (entry) =>
        entry.pathKey === JSON.stringify([...importedRoot, "LJ_raise.txt"])
    ).value,
    source
  );
  const subtree = deepest.slice(0, -1);
  assert.equal(
    await Db.renameItem("ranges", record(subtree, 1), "Renamed"),
    true
  );
  const renamed = [...subtree.slice(0, -1), "Renamed"];
  records = await Db.getArray("ranges");
  assert.equal(
    records.find(
      (entry) => entry.pathKey === JSON.stringify([...renamed, "LJ_raise.txt"])
    ).value,
    "AA:0.5"
  );
  assert.equal(
    await Db.renameItem(
      "ranges",
      record(importedRoot, 1),
      `${importedRoot[0]} (2)`
    ),
    false
  );
  assert.deepEqual(await Db.getArray("ranges"), records);
  assert.equal(await Db.deleteItem("ranges", record(renamed, 1)), true);
  records = await Db.getArray("ranges");
  assert.ok(!records.some((entry) => Db.withinPath(entry.path, renamed)));
  assert.ok(
    records.some(
      (entry) =>
        entry.path[0] === `${importedRoot[0]} (2)` &&
        entry.path.at(-1) === "LJ_raise.txt"
    )
  );
  assert.equal(
    records.find((entry) => entry.pathKey === '["Test","Range"]').value,
    source
  );
});

test("recursive picker renders groups and range rows beyond the old four-level limit", async () => {
  const { parse, compileScript } = require("@vue/compiler-sfc");
  const { createSSRApp, h } = require("vue");
  const { renderToString } = require("@vue/server-renderer");
  const filename = path.resolve(
    __dirname,
    "../src/components/DbPickerNode.vue"
  );
  const { descriptor } = parse(fs.readFileSync(filename, "utf8"), { filename });
  const script = compileScript(descriptor, {
    id: "picker-test",
    inlineTemplate: true,
  });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`, {
    filename,
  })(require, exports);
  const entries = planFolderImport(folderEntries, [], []).items;
  const tree = buildTree(entries);
  const openAll = (items) =>
    items.forEach((entry) => {
      if (entry.isGroup) {
        entry.opened = true;
        openAll(entry.items);
      }
    });
  openAll(tree);
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(exports.default, {
          item: tree[0],
          root: true,
          radioName: "test",
          selectedValue: false,
          editingName: "",
          isNameValid: true,
        }),
    })
  );
  assert.equal((html.match(/type="radio"/g) ?? []).length, entries.length);
  assert.ok(html.includes("空群組"));
  assert.ok(html.includes("(Empty group)"));
  assert.equal((html.match(/>LJ_raise\.txt</g) ?? []).length, 2);
});
