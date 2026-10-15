<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import Toolbar from "./components/Toolbar.vue";
import ThumbnailsPanel from "./components/ThumbnailsPanel.vue";
import PdfViewer from "./components/PdfViewer.vue";
import FormPanel from "./components/FormPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import {
  cancelPlacement,
  deleteSelectedAnnotation,
  placeText,
  setCurrentPage,
  state,
  undo,
  redo,
} from "./store";
import { clamp } from "./lib/geometry";

const viewerRef = ref<InstanceType<typeof PdfViewer> | null>(null);
const textPrompt = ref<{ page: number; x: number; y: number; value: string } | null>(null);

/** Keep viewer navigation and the store's one-based current page in sync. */
function onJump(page: number): void {
  const targetPage = clamp(page, 1, state.pageCount);
  setCurrentPage(targetPage);
  viewerRef.value?.scrollToPage(targetPage);
}

/** Open a text draft at a PDF-space point on a zero-based page. */
function onRequestText(position: { page: number; x: number; y: number }): void {
  textPrompt.value = { ...position, value: "" };
}

/** Insert a nonempty text draft, then close the placement dialog. */
async function insertText(): Promise<void> {
  if (!textPrompt.value) return;
  const text = textPrompt.value.value.trim();
  if (text) await placeText(textPrompt.value.page, textPrompt.value.x, textPrompt.value.y, text);
  textPrompt.value = null;
}

/** Handle document shortcuts without overriding native text undo, composition, or modal editing. */
function onKey(e: KeyboardEvent): void {
  const typing =
    e.target instanceof Element &&
    e.target.closest("input, textarea, select, [contenteditable], .note-popup");
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || (key === "y" && !e.shiftKey))) {
    if (
      e.repeat ||
      e.defaultPrevented ||
      e.isComposing ||
      state.busy ||
      textPrompt.value ||
      typing ||
      document.querySelector(".note-popup")
    )
      return;
    const direction = key === "y" || e.shiftKey ? "redo" : "undo";
    if (!(direction === "undo" ? state.undoLabel : state.redoLabel)) return;
    e.preventDefault();
    void (direction === "undo" ? undo() : redo());
    return;
  }
  if (e.key === "Delete") {
    if (
      e.repeat ||
      e.defaultPrevented ||
      textPrompt.value ||
      state.busy ||
      !state.selectedAnnotation
    )
      return;
    if (typing) return;
    e.preventDefault();
    void deleteSelectedAnnotation();
    return;
  }
  if (e.key !== "Escape") return;
  if (textPrompt.value) textPrompt.value = null;
  else cancelPlacement();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="app">
    <Toolbar @fit-width="viewerRef?.fitWidth()" @goto-page="onJump" />
    <div class="main">
      <ThumbnailsPanel v-if="state.bytes" @jump="onJump" />
      <PdfViewer ref="viewerRef" @request-text="onRequestText" />
      <FormPanel
        v-if="state.showFormsPanel && state.formFields.length"
        @goto-page="onJump"
        @close="state.showFormsPanel = false"
      />
    </div>
    <StatusBar />

    <div v-if="textPrompt" class="modal-backdrop" @click.self="textPrompt = null">
      <div class="modal">
        <h3>Add text to page {{ textPrompt.page + 1 }}</h3>
        <textarea
          v-model="textPrompt.value"
          rows="4"
          autofocus
          placeholder="Type the text to insert…"
        ></textarea>
        <label class="size-label">
          Font size:
          <input type="number" v-model.number="state.textSize" min="6" max="96" />
        </label>
        <div class="modal-actions">
          <button @click="textPrompt = null">Cancel</button>
          <button class="primary" @click="insertText">Insert</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}

body {
  font-family:
    "Segoe UI",
    system-ui,
    -apple-system,
    sans-serif;
  background: #1b1c20;
  color: #e6e7ea;
  overflow: hidden;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Shared button look (components add their own layout) */
button {
  font-family: inherit;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  width: 420px;
  max-width: 90vw;
  background: #26272c;
  border: 1px solid #3a3d45;
  border-radius: 10px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}

.modal h3 {
  margin: 0;
  font-size: 15px;
}

.modal textarea {
  background: #1e1f24;
  border: 1px solid #3a3d45;
  color: #e6e7ea;
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

button.primary {
  background: #2b6cb0;
  border-color: #3f83d4;
  color: #fff;
}
</style>
