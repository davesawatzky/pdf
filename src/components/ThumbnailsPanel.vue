<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { clearSelection, getPdfDoc, movePage as storeMovePage, selectPage, state } from "../store";
import { renderThumbnail } from "../lib/pdfjs";

const emit = defineEmits<{
  (e: "jump", page: number): void;
}>();

interface Thumbnail {
  canvas: HTMLCanvasElement | null;
  slot: HTMLElement | null;
}

const thumbs = reactive<Thumbnail[]>([]);
let renderVersion = 0;

/** Attach a thumbnail slot, including a canvas that finished rendering before the slot mounted. */
function setSlot(element: unknown, index: number): void {
  const thumbnail = thumbs[index];
  if (!thumbnail) return;
  thumbnail.slot = element instanceof HTMLElement ? element : null;
  if (thumbnail.slot && thumbnail.canvas && !thumbnail.slot.contains(thumbnail.canvas))
    thumbnail.slot.replaceChildren(thumbnail.canvas);
}

/** Replace stale thumbnails in page order, ignoring results from superseded document versions. */
async function renderAll(): Promise<void> {
  const version = ++renderVersion;
  const pdf = getPdfDoc();
  if (!pdf || !state.pageCount) return;
  while (thumbs.length < state.pageCount) thumbs.push({ canvas: null, slot: null });
  thumbs.length = state.pageCount;
  for (const thumbnail of thumbs) {
    thumbnail.canvas = null;
    thumbnail.slot?.replaceChildren();
  }
  for (let i = 0; i < state.pageCount; i++) {
    if (version !== renderVersion) return;
    try {
      const canvas = await renderThumbnail(pdf, i + 1, 128);
      if (version === renderVersion && thumbs[i]) {
        thumbs[i].canvas = canvas;
        thumbs[i].slot?.replaceChildren(canvas);
      }
    } catch (err) {
      console.error(`Failed to render thumbnail ${i + 1}`, err);
    }
  }
}

watch(
  () => [state.version, state.pageCount],
  () => {
    void renderAll();
  },
  { immediate: true },
);

const dragIndex = ref<number | null>(null);
const dropTarget = ref<number | null>(null);
const dropBefore = ref(true);

/** Track the source page's zero-based index and advertise a move operation. */
function onDragStart(event: DragEvent, index: number): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
}

/** Preview insertion before or after the hovered thumbnail's midpoint. */
function onDragOver(event: DragEvent, index: number): void {
  dropTarget.value = index;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropBefore.value = event.clientY < rect.top + rect.height / 2;
}

/** Commit reordering at the original list's insertion boundary, then clear drag indicators. */
function onDrop(index: number): void {
  const from = dragIndex.value;
  dragIndex.value = null;
  dropTarget.value = null;
  if (from === null || from === index) return;
  const to = dropBefore.value ? index : index + 1;
  void storeMovePage(from, to);
}

/** Clear drag indicators after cancellation or a completed drop. */
function onDragEnd(): void {
  dragIndex.value = null;
  dropTarget.value = null;
}
</script>

<template>
  <aside class="thumbs-panel" @click.self="clearSelection">
    <div
      v-for="(t, i) in thumbs"
      :key="i"
      class="thumb"
      :class="{
        selected: state.selected.includes(i),
        current: state.currentPage === i + 1,
        'drop-before': dropTarget === i && dropBefore,
        'drop-after': dropTarget === i && !dropBefore,
      }"
      draggable="true"
      @click="selectPage(i, $event.ctrlKey || $event.metaKey)"
      @dblclick="emit('jump', i + 1)"
      @dragstart="onDragStart($event, i)"
      @dragover.prevent="onDragOver($event, i)"
      @drop.prevent="onDrop(i)"
      @dragend="onDragEnd"
    >
      <div class="thumb-canvas" :ref="(el) => setSlot(el, i)"></div>
      <span class="num">{{ i + 1 }}</span>
    </div>
  </aside>
</template>

<style scoped>
.thumbs-panel {
  width: 170px;
  flex-shrink: 0;
  background: #202125;
  border-right: 1px solid #2e3036;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.thumb {
  position: relative;
  border-radius: 8px;
  border: 2px solid transparent;
  background: #17181c;
  padding: 6px 6px 4px;
  cursor: pointer;
  transition: border-color 0.1s;
}

.thumb:hover {
  border-color: #3a3d45;
}

.thumb.selected {
  border-color: #4d9fff;
}

.thumb-canvas canvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
  background: #fff;
}

.num {
  position: absolute;
  bottom: 2px;
  right: 6px;
  font-size: 10px;
  color: #8b909c;
  background: rgba(0, 0, 0, 0.5);
  padding: 1px 5px;
  border-radius: 8px;
}

.thumb.selected .num {
  color: #fff;
}

/* Drop-position indicator */
.thumb.drop-before::before,
.thumb.drop-after::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 3px;
  background: #4d9fff;
  border-radius: 2px;
}

.thumb.drop-before::before {
  top: -6px;
}

.thumb.drop-after::after {
  bottom: -6px;
}
</style>
