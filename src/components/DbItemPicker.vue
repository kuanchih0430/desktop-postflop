<template>
  <div
    class="w-full h-[22.5rem] px-1 border border-gray-500 rounded-md shadow text-sm overflow-x-auto overflow-y-scroll select-none"
    @click="unselect"
    @keydown.f2="!isImporting && renameItem()"
    @keydown.delete="!isImporting && deleteItem(true)"
  >
    <!-- No saved items -->
    <div v-if="data.length === 0" class="pl-5">
      <span class="inline-block px-1">(No saved {{ storeName }})</span>
    </div>

    <DbPickerNode
      v-for="item in data"
      :key="item.pathStr"
      :item="item"
      :root="true"
      :radio-name="`item-picker-${storeName}-${index}`"
      :selected-value="selectedValue"
      :editing-name="editingName"
      :is-name-valid="isNameValid"
      @select="selectedValue = $event"
      @toggle="toggleGroup"
      @activate="activateItem"
      @update-editing-name="editingName = $event"
      @rename="tryRename"
      @cancel-rename="cancelRename"
    />
  </div>

  <div v-if="errorOccured" class="mt-3 text-red-500 font-semibold">
    Something went wrong. Please relaunch the app.
  </div>

  <fieldset class="flex flex-col mt-4 gap-3" :disabled="isImporting">
    <div class="grid grid-cols-3 w-full gap-3">
      <button
        class="button-base button-blue button-overrides"
        :disabled="selectedItem?.item?.isGroup ?? true"
        @click="loadItem()"
      >
        Load
      </button>

      <button
        class="button-base button-blue button-overrides"
        :disabled="errorOccured || !allowSave || isEditing"
        @click="addOrOverwriteItem()"
      >
        {{ selectedItem?.item?.isGroup === false ? "Overwrite" : "Save" }}
      </button>

      <button
        class="button-base button-blue button-overrides"
        :disabled="errorOccured || selectedValue === false"
        @click="renameItem()"
      >
        Rename
      </button>
    </div>

    <div class="grid grid-cols-2 w-full gap-3">
      <button
        class="button-base button-blue button-overrides"
        :disabled="errorOccured || isImporting"
        @click="addGroup()"
      >
        Add Group
      </button>

      <button
        class="button-base button-red button-overrides"
        :disabled="errorOccured || selectedValue === false"
        @click="deleteItem(true)"
      >
        Delete
      </button>

      <button
        v-if="!hideImportExport"
        class="button-base button-green button-overrides"
        :disabled="errorOccured || isEditing"
        @click="importJson"
      >
        Import JSON
      </button>

      <button
        v-if="!hideImportExport"
        class="button-base button-green button-overrides"
        :disabled="errorOccured || isEditing"
        @click="exportJson"
      >
        Export JSON
      </button>
    </div>
    <button
      v-if="storeName === 'ranges' && !hideImportExport"
      class="button-base button-green button-overrides"
      :disabled="errorOccured || isEditing"
      @click="importFolder"
    >
      {{ isImporting ? "Importing folder…" : "Import Folder" }}
    </button>
    <p
      v-if="importStatus"
      class="text-sm text-gray-600"
      role="status"
      aria-live="polite"
    >
      {{ importStatus }}
    </p>
  </fieldset>

  <div
    v-if="importError !== ''"
    class="flex flex-col mt-4 px-2 py-1 text-red-500 bg-red-50 border-2 border-red-600 rounded-md font-semibold"
  >
    <div class="flex">
      Error: Import failed.
      <button
        class="w-6 h-6 ml-auto text-gray-700 opacity-70 hover:opacity-100"
        @click="importError = ''"
      >
        <XMarkIcon class="w-full h-full" />
      </button>
    </div>
    <div>- {{ importError }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import DbPickerNode from "./DbPickerNode.vue";
import { buildTree, type Item, type Group } from "../db-tree";
import { rangeImportFolder } from "../invokes";
import { planFolderImport } from "../range-folder-import";
import * as Db from "../db";

import { open, save } from "@tauri-apps/api/dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/api/fs";

import { XMarkIcon } from "@heroicons/vue/20/solid";

const isEqual = (lhs: unknown, rhs: unknown) => {
  if (lhs === null || typeof lhs !== "object") return lhs === rhs;
  if (Array.isArray(lhs)) {
    if (!Array.isArray(rhs) || lhs.length !== rhs.length) return false;
    for (let i = 0; i < lhs.length; ++i) {
      if (!isEqual(lhs[i], rhs[i])) return false;
    }
  } else {
    if (rhs === null || typeof rhs !== "object") return false;
    const lhsEntries = Object.entries(lhs);
    const rhsEntries = Object.entries(rhs);
    if (lhsEntries.length !== rhsEntries.length) return false;
    lhsEntries.sort((a, b) => a[0].localeCompare(b[0]));
    rhsEntries.sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 0; i < lhsEntries.length; ++i) {
      if (lhsEntries[i][0] !== rhsEntries[i][0]) return false;
      if (!isEqual(lhsEntries[i][1], rhsEntries[i][1])) return false;
    }
  }
  return true;
};

const clone = (value: unknown) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return [...value];
  return { ...value };
};

const groupToDbGroup = (group: Group): Db.DbGroup => ({
  path: [...group.path],
  pathKey: group.pathStr,
  isGroup: 1,
});

const itemToDbItem = (item: Item): Db.DbItem => ({
  path: [...item.path],
  pathKey: item.pathStr,
  isGroup: 0,
  value: clone(item.value),
});

const toDbItemOrGroup = (itemOrGroup: Item | Group): Db.DbItem | Db.DbGroup =>
  itemOrGroup.isGroup ? groupToDbGroup(itemOrGroup) : itemToDbItem(itemOrGroup);

type AddItemMessage = {
  type: "addItem";
  path: string[];
  value: unknown;
};

type OverwriteItemMessage = {
  type: "overwriteItem";
  path: string[];
  value: unknown;
};

type RenameItemMessage = {
  type: "renameItem";
  path: string[];
  newName: string;
};

type AddGroupMessage = {
  type: "addGroup";
  path: string[];
};

type DeleteItemMessage = {
  type: "deleteItem";
  path: string[];
};

type ImportJsonMessage = {
  type: "importJson";
};

type Message =
  | AddItemMessage
  | OverwriteItemMessage
  | RenameItemMessage
  | AddGroupMessage
  | DeleteItemMessage
  | ImportJsonMessage;

interface Props {
  storeName: string;
  index?: number;
  value: unknown;
  allowSave: boolean;
  hideImportExport?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  index: 0,
  hideImportExport: false,
});
const emit = defineEmits<{ (event: "load-item", value: unknown): void }>();

const data = ref<(Item | Group)[]>([]);
const selectedValue = ref(false as false | string);

const selectedItem = computed(() => {
  if (selectedValue.value === false) return null;
  const path = JSON.parse(selectedValue.value);
  let item: Item | Group | undefined;
  let items = data.value;
  for (let i = 0; i < path.length; ++i) {
    item = items.find((item) => item.path[i] === path[i]);
    if (item === undefined) return null;
    if (i < path.length - 1) {
      if (!item.isGroup) return null;
      items = item.items;
    }
  }
  return item ? { item, parentItems: items } : null;
});

const errorOccured = ref(false);

// load data from DB
const loadData = async () => {
  const masterData = await Db.getArray(props.storeName);

  try {
    data.value = buildTree(masterData);
    selectedValue.value = false;
  } catch {
    errorOccured.value = true;
  }
};

loadData().catch(() => {
  errorOccured.value = true;
});

// Broadcast channel
const channel = new BroadcastChannel(`item-picker-${props.storeName}`);
onUnmounted(() => channel.close());

channel.onmessage = async (event: MessageEvent<Message>) => {
  if (errorOccured.value) return;

  const message = event.data;
  const pathStr =
    message.type === "importJson" ? "" : JSON.stringify(message.path);

  if (message.type === "addItem") {
    // add item
    if (message.path.length > 1) {
      selectedValue.value = JSON.stringify(message.path.slice(0, -1));
      if (selectedItem.value === null) {
        errorOccured.value = true;
        selectedValue.value = false;
        return;
      }
    } else {
      selectedValue.value = false;
    }
    await addOrOverwriteItem(
      message.value,
      message.path[message.path.length - 1]
    );
  } else if (message.type === "overwriteItem") {
    // overwrite item
    selectedValue.value = pathStr;
    if (selectedItem.value === null) {
      errorOccured.value = true;
      selectedValue.value = false;
      return;
    }
    await addOrOverwriteItem(message.value);
  } else if (message.type === "renameItem") {
    // rename item
    selectedValue.value = pathStr;
    if (selectedItem.value === null) {
      errorOccured.value = true;
      selectedValue.value = false;
      return;
    }
    await tryRename(selectedItem.value.item, message.newName);
  } else if (message.type === "addGroup") {
    // add group
    if (message.path.length > 1) {
      selectedValue.value = JSON.stringify(message.path.slice(0, -1));
      if (selectedItem.value === null) {
        errorOccured.value = true;
        selectedValue.value = false;
        return;
      }
    } else {
      selectedValue.value = false;
    }
    await addGroup(message.path[message.path.length - 1]);
  } else if (message.type === "deleteItem") {
    // delete item
    selectedValue.value = pathStr;
    if (selectedItem.value === null) {
      errorOccured.value = true;
      selectedValue.value = false;
      return;
    }
    await deleteItem(false);
  } else if (message.type === "importJson") {
    // import JSON
    await loadData();
  }
};

const isEditing = ref(false);
const editingName = ref("");
const duplicateName = ref([] as string[]);

const unselect = (ev: MouseEvent) => {
  const target = ev.target as HTMLElement;
  if (target.tagName === "DIV") {
    selectedValue.value = false;
  }
};

const closeGroup = (group: Group) => {
  group.opened = false;
  for (const child of group.items) {
    if (child.isGroup) {
      closeGroup(child);
    }
  }
};

const toggleGroup = (group: Group) => {
  selectedValue.value = false;
  if (group.opened) {
    closeGroup(group);
  } else {
    group.opened = true;
  }
};

const loadItem = () => {
  if (!selectedItem.value) return;
  if (selectedItem.value.item.isGroup === false) {
    emit("load-item", selectedItem.value.item.value);
  }
  selectedValue.value = false;
};

const activateItem = (item: Item | Group) => {
  if (item.isGroup) toggleGroup(item);
  else {
    selectedValue.value = item.pathStr;
    loadItem();
  }
};

const addOrOverwriteItem = async (value?: unknown, name?: string) => {
  if (errorOccured.value) return;

  if (selectedItem.value?.item?.isGroup === false) {
    // overwrite
    selectedItem.value.item.value = value ?? props.value;

    if (value === undefined) {
      // save and broadcast
      errorOccured.value ||= !(await Db.overwriteItem(
        props.storeName,
        itemToDbItem(selectedItem.value.item)
      ));
      channel.postMessage({
        type: "overwriteItem",
        path: [...selectedItem.value.item.path],
        value: clone(props.value),
      } as OverwriteItemMessage);
    }

    selectedValue.value = false;
  } else {
    // add
    const path = selectedItem.value?.item
      ? [...selectedItem.value.item.path, name ?? ""]
      : [name ?? ""];
    const pathStr = JSON.stringify(path);
    const parentItems = selectedItem.value?.item?.items ?? data.value;
    parentItems.push({
      isGroup: false,
      path,
      pathStr,
      value: value ?? props.value,
      isEditing: false,
    });

    if (name === undefined) {
      // user must enter a name
      if (selectedItem.value) {
        selectedItem.value.item.opened = true;
      }
      selectedValue.value = pathStr;
      await renameItem();
    } else {
      // name is provided
      selectedValue.value = false;
      const depth = path.length - 1;
      parentItems.sort(
        (a, b) =>
          Number(b.isGroup) - Number(a.isGroup) ||
          a.path[depth].localeCompare(b.path[depth], undefined, {
            numeric: true,
          })
      );
    }
  }
};

const isNameValid = computed(() => {
  const name = editingName.value.trim();
  return name !== "" && !duplicateName.value.includes(name);
});

const renameItem = async () => {
  if (!selectedItem.value || errorOccured.value) return;
  const item = selectedItem.value.item;
  item.isEditing = true;
  isEditing.value = true;
  editingName.value = item.path[item.path.length - 1];
  duplicateName.value = selectedItem.value.parentItems
    .map((item) => item.path[item.path.length - 1])
    .filter((name) => name !== editingName.value);
  const defaultName = item.isGroup
    ? "New group"
    : `New ${props.storeName.slice(0, -1)}`; // remove "s" hack
  if (editingName.value === "") {
    let i = 2;
    let newName = defaultName;
    while (duplicateName.value.includes(newName)) {
      newName = `${defaultName} (${i++})`;
    }
    editingName.value = newName;
  }
  selectedValue.value = false;
  await nextTick();
};

const tryRename = async (item: Item | Group, newName?: string) => {
  // existence check (`tryRename()` might be called when an item is deleted)
  selectedValue.value = item.pathStr;
  if (selectedItem.value === null) {
    selectedValue.value = false;
    return;
  }

  const isUserAction = newName === undefined;

  if (newName === undefined) {
    // is user action
    item.isEditing = false;
    isEditing.value = false;

    if (!isNameValid.value) {
      editingName.value = "";
      if (item.path[item.path.length - 1] === "") {
        await deleteItem(false);
      }
      return;
    }

    newName = editingName.value.trim();
    editingName.value = "";
  }

  if (errorOccured.value) return;

  const depth = item.path.length - 1;
  const isNewItem = item.path[depth] === "";
  const prevPath = [...item.path];

  if (item.path[depth] === newName) {
    if (isUserAction) {
      // give focus
      await nextTick();
      const name = `item-picker-${props.storeName}-${props.index}`;
      const checked = document.querySelector(`input[name="${name}"]:checked`);
      if (checked) {
        (checked as HTMLInputElement).focus();
      }
    }

    return;
  }

  item.path[depth] = newName;
  item.pathStr = JSON.stringify(item.path);
  if (item.isGroup) {
    renameRecursive(item, newName, depth);
  }

  selectedValue.value = item.pathStr;
  const parentItems = selectedItem.value?.parentItems;
  if (parentItems) {
    parentItems.sort(
      (a, b) =>
        Number(b.isGroup) - Number(a.isGroup) ||
        a.path[depth].localeCompare(b.path[depth], undefined, {
          numeric: true,
        })
    );
  }

  if (isUserAction) {
    // save and broadcast
    if (isNewItem) {
      // add
      if (!item.isGroup) {
        // item
        errorOccured.value ||= !(await Db.addItem(
          props.storeName,
          itemToDbItem(item)
        ));
        channel.postMessage({
          type: "addItem",
          path: [...item.path],
          value: clone(item.value),
        } as AddItemMessage);
      } else {
        // group
        errorOccured.value ||= !(await Db.addGroup(
          props.storeName,
          groupToDbGroup(item)
        ));
        channel.postMessage({
          type: "addGroup",
          path: [...item.path],
        } as AddGroupMessage);
      }
    } else {
      // rename
      errorOccured.value ||= !(await Db.renameItem(
        props.storeName,
        toDbItemOrGroup({ ...item, path: prevPath }),
        newName
      ));
      channel.postMessage({
        type: "renameItem",
        path: prevPath,
        newName: newName,
      } as RenameItemMessage);
    }

    // give focus
    await nextTick();
    const name = `item-picker-${props.storeName}-${props.index}`;
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    if (checked) {
      (checked as HTMLInputElement).focus();
    }
  } else {
    selectedValue.value = false;
  }
};

const renameRecursive = (group: Group, newName: string, depth: number) => {
  for (const item of group.items) {
    item.path[depth] = newName;
    item.pathStr = JSON.stringify(item.path);
    if (item.isGroup) {
      renameRecursive(item, newName, depth);
    }
  }
};

const cancelRename = async (item: Item | Group) => {
  item.isEditing = false;
  isEditing.value = false;
  editingName.value = "";
  if (item.path[item.path.length - 1] === "") {
    selectedValue.value = item.pathStr;
    await deleteItem(false);
  }
};

const addGroup = async (name?: string) => {
  if (errorOccured.value) return;

  const path = selectedItem.value
    ? selectedItem.value.item.isGroup
      ? [...selectedItem.value.item.path, name ?? ""]
      : [...selectedItem.value.item.path.slice(0, -1), name ?? ""]
    : [name ?? ""];
  const pathStr = JSON.stringify(path);
  const parentItems = selectedItem.value
    ? selectedItem.value.item.isGroup
      ? selectedItem.value.item.items
      : selectedItem.value.parentItems
    : data.value;
  parentItems.push({
    isGroup: true,
    path,
    pathStr,
    opened: false,
    isEditing: false,
    items: [],
  });

  if (name === undefined) {
    // user must enter a name
    if (selectedItem.value?.item?.isGroup) {
      selectedItem.value.item.opened = true;
    }
    selectedValue.value = pathStr;
    renameItem();
  } else {
    // name is provided
    selectedValue.value = false;
    const depth = path.length - 1;
    parentItems.sort(
      (a, b) =>
        Number(b.isGroup) - Number(a.isGroup) ||
        a.path[depth].localeCompare(b.path[depth], undefined, {
          numeric: true,
        })
    );
  }
};

const deleteItem = async (isUserAction: boolean) => {
  if (!selectedItem.value || errorOccured.value) return;

  const path = [...selectedItem.value.item.path];
  const dbItem = toDbItemOrGroup(selectedItem.value.item);

  const parentItems = selectedItem.value.parentItems;
  parentItems.splice(parentItems.indexOf(selectedItem.value.item), 1);
  selectedValue.value = false;

  if (isUserAction) {
    // save and broadcast
    errorOccured.value ||= !(await Db.deleteItem(props.storeName, dbItem));
    channel.postMessage({
      type: "deleteItem",
      path,
    } as DeleteItemMessage);
  }
};

const importError = ref("");
const importStatus = ref("");
const isImporting = ref(false);

const importFolder = async () => {
  if (errorOccured.value || isEditing.value || isImporting.value) return;
  const selected = selectedItem.value?.item;
  const parent = selected
    ? selected.isGroup
      ? [...selected.path]
      : selected.path.slice(0, -1)
    : [];
  isImporting.value = true;
  importError.value = "";
  importStatus.value = "Choose a folder of .txt ranges…";
  try {
    const path = await open({
      title: "Import range folder",
      directory: true,
      multiple: false,
    });
    if (typeof path !== "string") {
      importStatus.value = "";
      return;
    }
    importStatus.value = "Reading and validating range files…";
    const entries = await rangeImportFolder(path);
    const { root, items } = planFolderImport(
      entries,
      parent,
      await Db.getArray(props.storeName)
    );
    importStatus.value = "Saving ranges…";
    if (!(await Db.bulkAdd(props.storeName, items)))
      throw new Error(
        "Could not save the imported folder. No ranges were imported."
      );
    channel.postMessage({ type: "importJson" });
    await loadData();
    let siblings = data.value;
    for (let depth = 0; depth < root.length; depth++) {
      const group = siblings.find((item) => item.path[depth] === root[depth]);
      if (!group?.isGroup) break;
      group.opened = true;
      siblings = group.items;
    }
    selectedValue.value = JSON.stringify(root);
    const count = entries.filter((entry) => !entry.isGroup).length;
    importStatus.value = `Imported ${count} range${
      count === 1 ? "" : "s"
    } into "${root[root.length - 1]}".`;
  } catch (error) {
    importError.value = String(error);
    importStatus.value = "";
  } finally {
    isImporting.value = false;
  }
};

type JsonItem = {
  path: string[];
  isGroup: boolean;
  value?: unknown;
};

const checkJson = (array: JsonItem[]) => {
  if (!Array.isArray(array)) return false;

  let valueType = "";
  if (props.storeName === "ranges") valueType = "string";
  if (props.storeName === "configurations") valueType = "object";
  if (valueType === "") return false;

  const map = new Map<string, boolean>();
  map.set(JSON.stringify([]), true);

  for (const item of array) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.isGroup !== "boolean" ||
      !Array.isArray(item.path) ||
      item.path.some((x) => typeof x !== "string") ||
      item.path.length === 0 ||
      (!item.isGroup && typeof item.value !== valueType)
    ) {
      return false;
    }

    item.path = item.path.map((x) => x.trim());

    if (
      item.path.some((x) => x === "") ||
      !map.get(JSON.stringify(item.path.slice(0, -1))) ||
      map.has(JSON.stringify(item.path))
    ) {
      return false;
    }

    map.set(JSON.stringify(item.path), item.isGroup);
  }

  return true;
};

const getItemsToAdd = async (array: JsonItem[]) => {
  const masterData = await Db.getArray(props.storeName);
  const masterMap = new Map<string, Db.DbItem | Db.DbGroup>();
  for (const item of masterData) {
    masterMap.set(item.pathKey, item);
  }

  const ret: (Db.DbItem | Db.DbGroup)[] = [];

  for (const item of array) {
    const depth = item.path.length;
    const name = item.path[depth - 1];
    let pathStr = JSON.stringify(item.path);

    if (item.isGroup) {
      const master = masterMap.get(pathStr);
      if (master && master.isGroup === 0) return name;
      if (!master) {
        ret.push({
          path: [...item.path],
          pathKey: pathStr,
          isGroup: 1,
        });
      }
    } else {
      let i = 2;
      let master = masterMap.get(pathStr);
      while (
        master &&
        (master.isGroup === 1 || !isEqual(master.value, item.value))
      ) {
        item.path[depth - 1] = `${name} (${i++})`;
        pathStr = JSON.stringify(item.path);
        master = masterMap.get(pathStr);
      }
      if (!master) {
        ret.push({
          path: [...item.path],
          pathKey: pathStr,
          isGroup: 0,
          value: item.value,
        });
      }
    }
    const added = ret[ret.length - 1];
    if (added) masterMap.set(added.pathKey, added);
  }

  return ret;
};

const importJson = async () => {
  if (errorOccured.value || isEditing.value) return;

  let filePath = await open({
    defaultPath: `${props.storeName}.json`,
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });

  if (!filePath) return;
  if (Array.isArray(filePath)) filePath = filePath[0];

  importError.value = "";

  const text = await readTextFile(filePath);
  let obj: { version: number; name: string; data: JsonItem[] };
  try {
    obj = JSON.parse(text);
  } catch (e) {
    importError.value = "Parse error (invalid JSON)";
    return;
  }

  if (!obj || (obj.version !== 2 && obj.version !== 3)) {
    importError.value = "Version mismatch";
    return;
  }

  if (obj.name !== props.storeName) {
    importError.value = "Data type mismatch";
    return;
  }

  if (!checkJson(obj.data)) {
    importError.value = "Invalid data";
    return;
  }

  const itemsToAdd = await getItemsToAdd(obj.data);
  if (typeof itemsToAdd === "string") {
    importError.value = `Cannot create group "${itemsToAdd}" because the item already exists`;
    return;
  }

  errorOccured.value ||= !(await Db.bulkAdd(props.storeName, itemsToAdd));
  channel.postMessage({ type: "importJson" });
  await loadData();
};

const appendRecursive = (item: Item | Group, array: JsonItem[]) => {
  array.push({
    path: item.path,
    isGroup: item.isGroup,
    value: item.isGroup ? undefined : item.value,
  });
  if (item.isGroup) {
    for (const child of item.items) {
      appendRecursive(child, array);
    }
  }
};

const exportJson = async () => {
  if (errorOccured.value || isEditing.value) return;

  const array: JsonItem[] = [];
  for (const item of data.value) {
    appendRecursive(item, array);
  }

  const version = array.some(
    (item) => item.path.length > (item.isGroup ? 3 : 4)
  )
    ? 3
    : 2;
  const obj = { version, name: props.storeName, data: array };
  const jsonStr = JSON.stringify(obj, undefined, 2);

  const filePath = await save({
    defaultPath: `${props.storeName}.json`,
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });

  if (filePath) {
    await writeTextFile(filePath, jsonStr);
  }
};
</script>

<style scoped>
.button-overrides {
  @apply px-0;
}
</style>
