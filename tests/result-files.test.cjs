const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { shallowRef } = require("vue");

// Exercise the actual TypeScript workflow with native dialogs and IPC replaced.
const code = ts.transpileModule(
  fs.readFileSync(require.resolve("../src/result-files.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }
).outputText;

const metadata = {
  formatVersion: 1,
  board: [0, 5, 22],
  startingPot: 20,
  effectiveStack: 100,
  iterations: 12,
  exploitability: 0.5,
  elapsedTimeMs: 1234,
  stoppedEarly: true,
  runSettings: {
    numThreads: 4,
    targetExploitability: 0.2,
    maxIterations: 2000,
  },
  solverSetup: {
    config: {
      board: [0, 5, 22],
      startingPot: 20,
      effectiveStack: 100,
      rakePercent: 5,
      rakeCap: 2,
      donkOption: true,
      oopFlopBet: "50",
      ipTurnRaise: "2.5x",
      oopRiverDonk: "75",
      expectedBoardLength: 3,
      addedLines: "X-B15",
      removedLines: "B10",
    },
    ranges: [
      Array.from({ length: 169 }, (_, i) => (i === 0 ? 50 : 0)),
      Array.from({ length: 169 }, (_, i) => (i === 14 ? 100 : 0)),
    ],
    rangeTexts: ["AA:0.5", "KK"],
    compressionEnabled: true,
  },
};

function harness() {
  const calls = [];
  const store = {
    isResultFileBusy: false,
    isTreeBuilding: false,
    isResultNavigating: false,
    isSolverRunning: false,
    isSolverPaused: false,
    isFinalizing: false,
    isBunchingRunning: false,
    isSolverFinished: true,
    isSolverError: false,
    resultHasBunching: false,
    resultMetadata: { ...metadata },
    resultFilePath: "",
    isResultDirty: true,
    resultRevision: 0,
    navView: "solver",
    ranges: Array.from({ length: 6 }, () => Array(169).fill(0)),
    headers: { "tree-config": ["Tree Configuration", "Tree Preview & Edit"] },
    $patch(values) {
      Object.assign(this, values);
    },
  };
  const saved = {
    board: [1, 2, 3],
    startingPot: 99,
    effectiveStack: 999,
    $reset() {
      this.board = [];
      this.startingPot = 0;
      this.effectiveStack = 0;
    },
    $patch(values) {
      Object.assign(this, values);
    },
  };
  const dependencies = {
    vue: { shallowRef },
    "./store": {
      useStore: () => store,
      useSavedConfigStore: () => saved,
      useConfigStore: () => editable,
      useTmpConfigStore: () => temporary,
    },
    "@tauri-apps/api/dialog": {
      open: async () => {
        calls.push("open-dialog");
        return "/new.dpfresult";
      },
      save: async () => {
        calls.push("save-dialog");
        return "/saved.dpfresult";
      },
    },
    "./invokes": {
      gameLoadResult: async (path) => {
        calls.push(["load", path]);
        return { ...metadata };
      },
      gameSaveResult: async (path, stats) => {
        calls.push(["save", path, stats.iterations]);
        return { ...metadata };
      },
    },
  };
  const editable = { ...saved, board: [...saved.board] };
  const temporary = { ...saved, board: [...saved.board] };
  const sandbox = {
    exports: {},
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(code, sandbox, { filename: "result-files.js" });
  return {
    flow: sandbox.exports,
    store,
    saved,
    editable,
    temporary,
    dependencies,
    calls,
  };
}

const tick = () => new Promise(setImmediate);

test("saving a stopped result preserves statistics and clears dirty only on success", async () => {
  const h = harness();
  assert.equal(await h.flow.saveCurrentResult(), true);
  assert.equal(h.store.resultFilePath, "/saved.dpfresult");
  assert.equal(h.store.isResultDirty, false);
  assert.equal(h.store.resultMetadata.stoppedEarly, true);
  assert.deepEqual(h.calls[1], ["save", "/saved.dpfresult", 12]);
});

test("canceling save or encountering a write failure keeps the result unsaved", async () => {
  const h = harness();
  h.dependencies["@tauri-apps/api/dialog"].save = async () => null;
  assert.equal(await h.flow.saveCurrentResult(), false);
  assert.equal(h.store.isResultDirty, true);
  h.dependencies["@tauri-apps/api/dialog"].save = async () =>
    "/saved.dpfresult";
  h.dependencies["./invokes"].gameSaveResult = async () => {
    throw new Error("disk full");
  };
  assert.equal(await h.flow.saveCurrentResult(), false);
  assert.equal(h.store.isResultDirty, true);
  assert.equal(h.store.isResultFileBusy, false);
  assert.match(h.flow.fileError.value, /disk full/);
});

test("canceling open does not prompt to discard the current result", async () => {
  const h = harness();
  h.dependencies["@tauri-apps/api/dialog"].open = async () => null;
  await h.flow.openSavedResult();
  assert.equal(h.flow.replacementRequest.value, null);
  assert.equal(h.store.isResultDirty, true);
});

test("canceling replacement preserves the current result and configuration", async () => {
  const h = harness();
  const opening = h.flow.openSavedResult();
  await tick();
  assert.equal(typeof h.flow.replacementRequest.value, "function");
  h.flow.finishReplacement(false);
  await opening;
  assert.deepEqual(h.calls, ["open-dialog"]);
  assert.equal(h.store.isResultDirty, true);
  assert.equal(h.saved.startingPot, 99);
});

test("discard and open replaces the result and refreshes consecutive loads", async () => {
  const h = harness();
  const opening = h.flow.openSavedResult();
  await tick();
  h.flow.finishReplacement(true);
  await opening;
  assert.equal(h.store.navView, "results");
  assert.equal(h.store.resultRevision, 1);
  assert.equal(h.store.isResultDirty, false);
  assert.equal(h.saved.startingPot, 20);
  assert.deepEqual([...h.saved.board], metadata.board);
  for (const config of [h.saved, h.editable, h.temporary]) {
    assert.equal(config.rakePercent, 5);
    assert.equal(config.rakeCap, 2);
    assert.equal(config.donkOption, true);
    assert.equal(config.oopFlopBet, "50");
    assert.equal(config.ipTurnRaise, "2.5x");
    assert.equal(config.oopRiverDonk, "75");
    assert.equal(config.addedLines, "X-B15");
    assert.equal(config.removedLines, "B10");
  }
  assert.deepEqual([...h.store.ranges[0]], metadata.solverSetup.ranges[0]);
  assert.deepEqual([...h.store.ranges[1]], metadata.solverSetup.ranges[1]);
  assert.equal(h.store.resultMetadata.runSettings.numThreads, 4);
  assert.equal(h.store.headers["tree-config"].length, 1);
  h.editable.board.push(30);
  assert.deepEqual([...h.saved.board], metadata.board);
  assert.deepEqual([...h.temporary.board], metadata.board);
  await h.flow.openSavedResult();
  assert.equal(h.store.resultRevision, 2);
});

test("save then open saves the old result before loading the new one", async () => {
  const h = harness();
  const opening = h.flow.openSavedResult();
  await tick();
  assert.equal(await h.flow.saveCurrentResult(), true);
  h.flow.finishReplacement(true);
  await opening;
  assert.deepEqual(
    h.calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ["open-dialog", "save-dialog", "save", "load"]
  );
});

test("canceling save within the replacement prompt leaves the prompt pending", async () => {
  const h = harness();
  const opening = h.flow.openSavedResult();
  await tick();
  h.dependencies["@tauri-apps/api/dialog"].save = async () => null;
  assert.equal(await h.flow.saveCurrentResult(), false);
  assert.equal(typeof h.flow.replacementRequest.value, "function");
  h.flow.finishReplacement(false);
  await opening;
  assert.equal(h.store.isResultDirty, true);
});

test("a failed load keeps the old result, configuration, revision and dirty flag", async () => {
  const h = harness();
  h.dependencies["./invokes"].gameLoadResult = async () => {
    throw new Error("invalid file");
  };
  const opening = h.flow.openSavedResult();
  await tick();
  h.flow.finishReplacement(true);
  await opening;
  assert.equal(h.store.isResultDirty, true);
  assert.equal(h.store.resultRevision, 0);
  assert.equal(h.store.resultMetadata.iterations, 12);
  assert.equal(h.saved.startingPot, 99);
  assert.equal(h.store.isResultFileBusy, false);
  assert.match(h.flow.fileError.value, /current result was kept/);
});

test("busy operations cannot load results, and Bunching results cannot be saved", async () => {
  for (const flag of [
    "isResultFileBusy",
    "isTreeBuilding",
    "isResultNavigating",
    "isSolverRunning",
    "isSolverPaused",
    "isFinalizing",
    "isBunchingRunning",
  ]) {
    const h = harness();
    h.store[flag] = true;
    await h.flow.openSavedResult();
    assert.equal(await h.flow.saveCurrentResult(), false);
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  h.store.resultHasBunching = true;
  assert.equal(await h.flow.saveCurrentResult(), false);
  assert.deepEqual(h.calls, []);
});
