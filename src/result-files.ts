import { shallowRef } from "vue";
import { open, save } from "@tauri-apps/api/dialog";
import { gameLoadResult, gameSaveResult } from "./invokes";
import {
  useConfigStore,
  useTmpConfigStore,
  useSavedConfigStore,
  useStore,
} from "./store";

const filters = [
  { name: "Desktop Postflop result", extensions: ["dpfresult"] },
];
export const fileMessage = shallowRef("");
export const fileError = shallowRef("");
export const replacementRequest = shallowRef<
  ((proceed: boolean) => void) | null
>(null);

export const confirmResultReplacement = async (): Promise<boolean> => {
  if (!useStore().isResultDirty) return true;
  return await new Promise((resolve) => {
    replacementRequest.value = resolve;
  });
};

export const finishReplacement = (proceed: boolean) => {
  const resolve = replacementRequest.value;
  replacementRequest.value = null;
  resolve?.(proceed);
};

export const saveCurrentResult = async (): Promise<boolean> => {
  const store = useStore();
  if (
    store.isResultFileBusy ||
    store.isTreeBuilding ||
    store.isResultNavigating ||
    store.isSolverRunning ||
    store.isSolverPaused ||
    store.isFinalizing ||
    store.isBunchingRunning ||
    !store.isSolverFinished ||
    !store.resultMetadata ||
    store.resultHasBunching
  )
    return false;

  store.isResultFileBusy = true;
  fileError.value = "";
  fileMessage.value = "";
  try {
    const path = await save({
      title: "Save solved result",
      defaultPath: store.resultFilePath || "solved-tree.dpfresult",
      filters,
    });
    if (!path) return false;
    const metadata = await gameSaveResult(path, store.resultMetadata);
    store.$patch({
      resultMetadata: metadata,
      resultFilePath: path,
      isResultDirty: false,
    });
    fileMessage.value = `Saved: ${path}`;
    return true;
  } catch (error) {
    fileError.value = `Could not save result: ${String(error)}`;
    return false;
  } finally {
    store.isResultFileBusy = false;
  }
};

export const openSavedResult = async () => {
  const store = useStore();
  if (
    store.isResultFileBusy ||
    store.isTreeBuilding ||
    store.isResultNavigating ||
    store.isSolverRunning ||
    store.isSolverPaused ||
    store.isFinalizing ||
    store.isBunchingRunning
  )
    return;

  store.isResultFileBusy = true;
  fileError.value = "";
  fileMessage.value = "";
  let path;
  try {
    path = await open({
      title: "Open solved result",
      multiple: false,
      filters,
    });
  } catch (error) {
    fileError.value = `Could not open file picker: ${String(error)}`;
    return;
  } finally {
    store.isResultFileBusy = false;
  }
  if (typeof path !== "string" || !(await confirmResultReplacement())) return;

  store.isResultFileBusy = true;
  try {
    const metadata = await gameLoadResult(path);
    const setup = metadata.solverSetup;
    const restoredConfig = setup?.config ?? {
      board: metadata.board,
      startingPot: metadata.startingPot,
      effectiveStack: metadata.effectiveStack,
    };
    for (const config of [
      useConfigStore(),
      useTmpConfigStore(),
      useSavedConfigStore(),
    ]) {
      config.$reset();
      config.$patch({ ...restoredConfig, board: [...restoredConfig.board] });
    }
    if (setup) {
      store.ranges[0] = [...setup.ranges[0]];
      store.ranges[1] = [...setup.ranges[1]];
    }
    store.headers["tree-config"] = ["Tree Configuration"];
    store.$patch({
      isSolverRunning: false,
      isSolverPaused: false,
      isSolverFinished: true,
      isSolverError: false,
      isFinalizing: false,
      resultMetadata: metadata,
      resultFilePath: path,
      isResultDirty: false,
      resultHasBunching: false,
      isBunchingEnabled: false,
      resultRevision: store.resultRevision + 1,
      navView: "results",
    });
    fileMessage.value = `Opened: ${path}`;
  } catch (error) {
    fileError.value = `Could not load result. The current result was kept. ${String(
      error
    )}`;
  } finally {
    store.isResultFileBusy = false;
  }
};
