<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { annotationTools, isAnnotationTool } from "../lib/annotationTools";
import { clamp } from "../lib/geometry";
import {
  deleteSelected,
  hasDoc,
  insertBlankPage,
  mergePdfAt,
  openFile,
  pickImageToInsert,
  rotateSelected,
  saveAs,
  saveCurrent,
  setZoom,
  startTextPlacement,
  startAnnotation,
  state,
  toggleFormsPanel,
  undo,
  redo,
} from "../store";

const emit = defineEmits<{
  "fit-width": [];
  "goto-page": [page: number];
}>();

const activeAnnotation = computed(() => (isAnnotationTool(state.mode) ? state.mode : null));
const documentReady = computed(() => state.bytes !== null && !state.busy && hasDoc());

// Page-number input kept as a string so partial typing works.
const pageInput = ref("1");
watch(
  () => state.currentPage,
  (v) => {
    pageInput.value = String(v);
  },
);

/** Navigate after a completed page input, preserving partial typing until change is emitted. */
function goToPage(): void {
  const page = parseInt(pageInput.value, 10);
  if (!Number.isFinite(page)) return;
  emit("goto-page", clamp(page, 1, state.pageCount));
}

/** Request the previous one-based viewer page. */
function prevPage(): void {
  emit("goto-page", state.currentPage - 1);
}

/** Request the next one-based viewer page. */
function nextPage(): void {
  emit("goto-page", state.currentPage + 1);
}

/** Increase zoom by one step within the store's supported scale limits. */
function zoomIn(): void {
  setZoom(state.zoom * 1.2);
}

/** Decrease zoom by one step within the store's supported scale limits. */
function zoomOut(): void {
  setZoom(state.zoom / 1.2);
}
</script>

<template>
  <div class="toolbar">
    <div class="group">
      <button @click="openFile" :disabled="state.busy">Open…</button>
      <button @click="saveCurrent" :disabled="!documentReady">Save</button>
      <button @click="saveAs" :disabled="!documentReady">Save As…</button>
    </div>

    <span class="sep" />

    <div class="group" aria-label="Edit history">
      <button
        :title="state.undoLabel ? `Undo: ${state.undoLabel} (Ctrl/⌘+Z)` : 'Undo (Ctrl/⌘+Z)'"
        :disabled="!documentReady || !state.undoLabel"
        @click="undo"
      >
        <svg class="history-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5 3 11l6 6 M3 11h11a6 6 0 0 1 6 6v3" />
        </svg>
        Undo
      </button>
      <button
        :title="
          state.redoLabel
            ? `Redo: ${state.redoLabel} (Ctrl/⌘+Shift+Z or Ctrl+Y)`
            : 'Redo (Ctrl/⌘+Shift+Z or Ctrl+Y)'
        "
        :disabled="!documentReady || !state.redoLabel"
        @click="redo"
      >
        <svg class="history-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 5 6 6-6 6 M21 11H10a6 6 0 0 0-6 6v3" />
        </svg>
        Redo
      </button>
    </div>

    <span class="sep" />

    <div class="group">
      <button
        title="Rotate selected (or current) page left"
        @click="rotateSelected(-1)"
        :disabled="!documentReady"
      >
        ⟲ Rotate L
      </button>
      <button
        title="Rotate selected (or current) page right"
        @click="rotateSelected(1)"
        :disabled="!documentReady"
      >
        ⟳ Rotate R
      </button>
      <button
        class="danger"
        title="Delete selected pages (or the current one)"
        @click="deleteSelected"
        :disabled="!documentReady"
      >
        🗑 Delete Page(s)
      </button>
      <button
        title="Insert a blank page after the current page"
        @click="insertBlankPage(state.currentPage - 1)"
        :disabled="!documentReady"
      >
        + Blank Page
      </button>
      <button
        title="Merge another PDF in after the current page"
        @click="mergePdfAt(state.currentPage - 1)"
        :disabled="!documentReady"
      >
        ⇄ Merge PDF…
      </button>
    </div>

    <span class="sep" />

    <div class="group">
      <button
        title="Insert an image (PNG/JPEG) — then click a page to place it"
        @click="pickImageToInsert"
        :disabled="!documentReady"
      >
        🖼 Insert Image…
      </button>
      <button
        title="Add text — then click a page to place it"
        @click="startTextPlacement"
        :disabled="!documentReady"
      >
        T Add Text
      </button>
      <label class="size-label"
        >Size <input type="number" v-model.number="state.textSize" min="6" max="96"
      /></label>
    </div>

    <span class="sep" />

    <div class="group annotations" aria-label="Annotation tools">
      <button
        v-for="(item, tool) in annotationTools"
        :key="tool"
        :title="item.label"
        :aria-pressed="state.mode === tool"
        :class="{ active: state.mode === tool }"
        :disabled="!documentReady"
        @click="startAnnotation(tool)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path :d="item.icon" />
        </svg>
        {{ item.label }}
      </button>
      <label v-if="activeAnnotation" class="color-label">
        Color
        <input
          type="color"
          :aria-label="`${annotationTools[activeAnnotation].label} color`"
          v-model="state.annotationColors[activeAnnotation]"
          :disabled="state.busy"
        />
      </label>
    </div>

    <span class="sep" />

    <div class="group">
      <button
        :class="{ active: state.showFormsPanel }"
        @click="toggleFormsPanel"
        :disabled="!documentReady"
      >
        Form Fields
      </button>
    </div>

    <div class="spacer" />

    <div class="group right">
      <button title="Zoom out" @click="zoomOut">−</button>
      <span class="zoom-label">{{ Math.round(state.zoom * 100) }}%</span>
      <button title="Zoom in" @click="zoomIn">+</button>
      <button @click="emit('fit-width')">Fit Width</button>

      <span class="sep" />

      <button title="Previous page" @click="prevPage" :disabled="state.currentPage <= 1">‹</button>
      <input
        class="page-input"
        type="number"
        min="1"
        :max="state.pageCount"
        v-model="pageInput"
        @change="goToPage"
      />
      <span class="of">/ {{ state.pageCount }}</span>
      <button title="Next page" @click="nextPage" :disabled="state.currentPage >= state.pageCount">
        ›
      </button>
    </div>
  </div>
</template>

<style scoped>
.history-icon {
  width: 16px;
  height: 16px;
  vertical-align: middle;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #232428;
  border-bottom: 1px solid #2e3036;
  flex-wrap: wrap;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.annotations button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.annotations svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.color-label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #c8ccd4;
  font-size: 12px;
}

.color-label input {
  width: 32px;
  height: 28px;
  padding: 2px;
  background: #2c2e34;
  border: 1px solid #4a4e59;
  border-radius: 4px;
  cursor: pointer;
}

button {
  background: #2c2e34;
  color: #e6e7ea;
  border: 1px solid #3a3d45;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s;
}

button:hover:not(:disabled) {
  background: #343741;
  border-color: #4a4e59;
}

button:disabled {
  opacity: 0.45;
  cursor: default;
}

button.danger:hover:not(:disabled) {
  background: #4a2730;
  border-color: #7c3a48;
  color: #ffb3bf;
}

button.active {
  background: #2b4a76;
  border-color: #3f6db3;
}

.sep {
  width: 1px;
  height: 22px;
  background: #33353d;
  margin: 0 4px;
}

.spacer {
  flex: 1;
}

.zoom-label,
.of {
  font-size: 12px;
  color: #9aa0ab;
  min-width: 34px;
  text-align: center;
}

.page-input,
.size-label input {
  width: 52px;
  background: #1e1f24;
  border: 1px solid #3a3d45;
  color: #e6e7ea;
  border-radius: 6px;
  padding: 5px 6px;
  font-size: 13px;
}

.size-label {
  font-size: 12px;
  color: #9aa0ab;
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
