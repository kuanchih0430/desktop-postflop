<template>
  <div
    class="min-w-max whitespace-nowrap"
    :class="
      root
        ? item.isGroup
          ? ''
          : 'item-toplevel'
        : item.isGroup
        ? 'group-inside'
        : 'item-inside'
    "
  >
    <button
      v-if="item.isGroup"
      :class="item.opened ? 'bottom-arrow' : 'right-arrow'"
      :aria-label="`${item.opened ? 'Collapse' : 'Expand'} ${name}`"
      :aria-expanded="item.opened"
      @click.stop="emit('toggle', item)"
    >
      &nbsp;
    </button>
    <input
      v-if="item.isEditing"
      ref="nameInput"
      :value="editingName"
      type="text"
      :class="['px-1 py-0 text-sm', { 'input-error': !isNameValid }]"
      :style="{ width: item.isGroup ? 'calc(100% - 1.25rem)' : '100%' }"
      @input="
        emit('update-editing-name', ($event.target as HTMLInputElement).value)
      "
      @blur="emit('rename', item)"
      @keydown.enter="emit('rename', item)"
      @keydown.escape="emit('cancel-rename', item)"
      @keydown.delete.stop
    />
    <label
      v-else
      class="inline-block"
      @dblclick="emit('activate', item)"
      @keydown.enter="emit('activate', item)"
    >
      <input
        type="radio"
        :name="radioName"
        class="sr-only peer"
        :value="item.pathStr"
        :checked="selectedValue === item.pathStr"
        @change="emit('select', item.pathStr)"
      />
      <span
        class="inline-block px-1 rounded-sm whitespace-nowrap peer-checked:bg-blue-600 peer-checked:text-white"
        >{{ name }}</span
      >
    </label>
    <div
      v-if="item.isGroup && item.opened"
      class="group"
      :style="{ '--guide-decrease': guideDecrease }"
    >
      <div v-if="item.items.length === 0" class="item-inside">
        <span class="inline-block px-1">(Empty group)</span>
      </div>
      <DbPickerNode
        v-for="child in item.items"
        :key="child.pathStr"
        :item="child"
        :radio-name="radioName"
        :selected-value="selectedValue"
        :editing-name="editingName"
        :is-name-valid="isNameValid"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @activate="emit('activate', $event)"
        @update-editing-name="emit('update-editing-name', $event)"
        @rename="emit('rename', $event)"
        @cancel-rename="emit('cancel-rename', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Item, Group } from "../db-tree";

const props = defineProps<{
  item: Item | Group;
  root?: boolean;
  radioName: string;
  selectedValue: false | string;
  editingName: string;
  isNameValid: boolean;
}>();
const emit = defineEmits<{
  (event: "select", value: string): void;
  (event: "toggle", item: Group): void;
  (event: "activate" | "rename" | "cancel-rename", item: Item | Group): void;
  (event: "update-editing-name", value: string): void;
}>();
const name = computed(() => props.item.path[props.item.path.length - 1]);
const nameInput = ref<HTMLInputElement | null>(null);
watch(
  () => props.item.isEditing,
  async (editing) => {
    if (!editing) return;
    await nextTick();
    nameInput.value?.select();
    nameInput.value?.scrollIntoView({ block: "nearest" });
  },
  { immediate: true }
);

const displayedRows = (group: Group): number =>
  group.opened
    ? (group.items.length || 1) +
      group.items.reduce(
        (sum, child) => sum + (child.isGroup ? displayedRows(child) : 0),
        0
      )
    : 0;
const guideDecrease = computed(() => {
  if (!props.item.isGroup) return 0;
  const last = props.item.items[props.item.items.length - 1];
  return last?.isGroup ? displayedRows(last) : 0;
});
</script>

<style scoped>
.group {
  @apply relative pl-5;
}
.group::before {
  content: "";
  height: calc(100% - 1.4rem * var(--guide-decrease) - 0.825rem);
  @apply absolute top-0.5 left-2.5 border-l border-dotted border-gray-500;
}
.group-inside {
  @apply relative;
}
.group-inside::before {
  content: "";
  @apply absolute top-[0.7rem] -left-[0.5625rem] w-2.5 border-t border-dotted border-gray-500;
}
.item-toplevel {
  @apply relative pl-5;
}
.item-toplevel::before {
  content: "";
  @apply absolute top-1/2 left-[0.0625rem] w-2.5 border-t border-dotted border-gray-500;
}
.item-inside {
  @apply relative pl-5;
}
.item-inside::before {
  content: "";
  @apply absolute top-1/2 -left-[0.5625rem] w-5 border-t border-dotted border-gray-500;
}
.right-arrow,
.bottom-arrow {
  @apply relative inline-block w-5 min-h-full;
}
.right-arrow::before {
  content: "";
  @apply absolute w-1.5 h-1.5 -mt-0.5 top-1/2 left-1.5 border-t-2 border-r-2 border-gray-500 rotate-45;
}
.bottom-arrow::before {
  content: "";
  @apply absolute w-1.5 h-1.5 -mt-[0.1875rem] top-1/2 left-[0.4375rem] border-r-2 border-b-2 border-gray-500 rotate-45;
}
</style>
