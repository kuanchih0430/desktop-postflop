<template>
  <div class="flex h-12 px-4 gap-3 items-center border-b bg-white text-sm">
    <button
      class="button-base button-blue"
      :disabled="isWorking"
      @click="openSavedResult"
    >
      Open Result
    </button>
    <button
      class="button-base button-green"
      :disabled="
        isWorking ||
        !store.isSolverFinished ||
        !store.resultMetadata ||
        store.resultHasBunching
      "
      :title="
        store.resultHasBunching
          ? 'Saving Bunching results is not supported yet.'
          : ''
      "
      @click="saveCurrentResult"
    >
      Save Result{{ store.isResultDirty ? " *" : "" }}
    </button>
    <span v-if="store.resultHasBunching" class="text-amber-700">
      Saving Bunching results is not supported yet.
    </span>
    <span v-else-if="store.resultMetadata" class="truncate text-gray-600">
      {{ store.resultMetadata.iterations }} iterations · Exploitability
      {{ store.resultMetadata.exploitability.toFixed(4) }} ({{
        (
          (store.resultMetadata.exploitability /
            store.resultMetadata.startingPot) *
          100
        ).toFixed(2)
      }}%) · {{ (store.resultMetadata.elapsedTimeMs / 1000).toFixed(2) }}s ·
      {{ store.resultMetadata.stoppedEarly ? "Stopped early" : "Finished" }}
    </span>
    <span
      class="ml-auto truncate text-gray-600"
      role="status"
      :title="fileMessage"
      >{{ fileMessage }}</span
    >
  </div>

  <div
    v-if="fileError"
    class="fixed bottom-4 left-4 right-4 z-50 flex p-4 gap-4 rounded bg-red-100 text-red-800 shadow"
    role="alert"
  >
    <span class="flex-grow">{{ fileError }}</span>
    <button aria-label="Dismiss error" @click="fileError = ''">Close</button>
  </div>

  <dialog
    ref="fileDialog"
    class="w-full max-w-lg rounded-lg border-0 bg-white p-6 shadow-xl backdrop:bg-black/40"
    aria-labelledby="replace-result-title"
    @cancel.prevent="!store.isResultFileBusy && finishReplacement(false)"
  >
    <div v-if="store.isResultFileBusy" role="status" aria-live="polite">
      Saving or opening result… Please wait.
    </div>
    <section v-else-if="replacementRequest">
      <h2 id="replace-result-title" class="text-lg font-semibold">
        Save the current result?
      </h2>
      <p class="mt-3">
        The current result has not been saved. Replacing it will discard this
        result.
      </p>
      <p v-if="store.resultHasBunching" class="mt-2 text-amber-700">
        Saving Bunching results is not supported yet. Cancel to keep this
        result.
      </p>
      <p v-if="fileError" class="mt-2 text-red-700" role="alert">
        {{ fileError }}
      </p>
      <div class="mt-6 flex flex-wrap justify-end gap-3">
        <button
          class="button-base button-blue"
          autofocus
          @click="finishReplacement(false)"
        >
          Cancel
        </button>
        <button class="button-base button-red" @click="finishReplacement(true)">
          Discard and Continue
        </button>
        <button
          class="button-base button-green"
          :disabled="store.resultHasBunching"
          @click="saveAndContinue"
        >
          Save and Continue
        </button>
      </div>
    </section>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useStore } from "../store";
import {
  fileError,
  fileMessage,
  replacementRequest,
  finishReplacement,
  openSavedResult,
  saveCurrentResult,
} from "../result-files";

const store = useStore();
const fileDialog = ref<HTMLDialogElement | null>(null);
watch(
  () => Boolean(replacementRequest.value || store.isResultFileBusy),
  (visible) => {
    if (visible && !fileDialog.value?.open) fileDialog.value?.showModal();
    else if (!visible) fileDialog.value?.close();
  },
  { flush: "post" }
);
const isWorking = computed(
  () =>
    store.isResultFileBusy ||
    store.isTreeBuilding ||
    store.isResultNavigating ||
    store.isSolverRunning ||
    store.isSolverPaused ||
    store.isFinalizing ||
    store.isBunchingRunning
);
const saveAndContinue = async () => {
  if (await saveCurrentResult()) finishReplacement(true);
};
</script>
