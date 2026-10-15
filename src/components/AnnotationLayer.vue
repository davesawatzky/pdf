<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { addPageAnnotation, editStickyNote, getPdfDoc, selectAnnotation, state } from "../store";
import { isAnnotationTool } from "../lib/annotations";
import type { AnnotationTool, Point, StickyNote } from "../lib/annotations";
import { pageViewportAtScale1 } from "../lib/pdfjs";
import AnnotationSelection from "./AnnotationSelection.vue";
import { pointBounds, pointerToViewport, rectCorners, toPdfPoint } from "../lib/geometry";

const props = defineProps<{ page: number }>();
const viewport = shallowRef<Awaited<ReturnType<typeof pageViewportAtScale1>> | null>(null);
const surface = ref<SVGSVGElement | null>(null);
const stroke = ref<{
  pointer: number;
  tool: Exclude<AnnotationTool, "sticky-note">;
  color: string;
  points: Point[];
} | null>(null);
const noteDraft = ref<{ id?: string; point: Point; text: string; color: string } | null>(null);
const active = computed(() => isAnnotationTool(state.mode));
const previewBox = computed(() => {
  const points = stroke.value?.points;
  if (!points?.length) return null;
  const first = points[0],
    last = points[points.length - 1];
  return pointBounds([first, last]);
});
let loadToken = 0;

watch(
  () => [state.version, props.page],
  async () => {
    const token = ++loadToken;
    viewport.value = null;
    stroke.value = null;
    noteDraft.value = null;
    const pdf = getPdfDoc();
    if (!pdf) return;
    try {
      const next = await pageViewportAtScale1(pdf, props.page);
      if (token === loadToken) viewport.value = next;
    } catch (error) {
      if (token === loadToken)
        state.error = error instanceof Error ? error.message : "Could not load annotation layer.";
    }
  },
  { immediate: true },
);

watch(
  () => [state.mode, state.zoom],
  () => {
    stroke.value = null;
    noteDraft.value = null;
  },
);
onBeforeUnmount(() => {
  loadToken++;
});

/** Convert a gesture point through the current viewport, respecting rotation and crop offsets. */
function toPdf(point: Point): Point {
  return toPdfPoint(viewport.value!, point);
}

/** Begin a mark or note draft; modifier-clicks are reserved for selecting existing annotations. */
function pointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !viewport.value || !active.value || state.busy || noteDraft.value)
    return;
  selectAnnotation(null);
  if (event.ctrlKey || event.metaKey) return;
  const point = pointerToViewport(event, surface.value!, viewport.value);
  if (state.mode === "sticky-note") {
    noteDraft.value = {
      point: toPdf(point),
      text: "",
      color: state.annotationColors["sticky-note"],
    };
    return;
  }
  if (state.mode !== "highlight" && state.mode !== "underline" && state.mode !== "draw") return;
  surface.value?.setPointerCapture(event.pointerId);
  stroke.value = {
    pointer: event.pointerId,
    tool: state.mode,
    color: state.annotationColors[state.mode],
    points: [point],
  };
}

/** Collect a freehand path or update the opposite corner of an area mark. */
function pointerMove(event: PointerEvent): void {
  if (!stroke.value || stroke.value.pointer !== event.pointerId) return;
  const point = pointerToViewport(event, surface.value!, viewport.value!);
  if (stroke.value.tool === "draw") stroke.value.points.push(point);
  else stroke.value.points = [stroke.value.points[0], point];
}

/** Commit a completed mark in PDF coordinates, ignoring click-sized accidental strokes. */
async function pointerUp(event: PointerEvent): Promise<void> {
  if (!stroke.value || stroke.value.pointer !== event.pointerId) return;
  pointerMove(event);
  const current = stroke.value;
  const box = previewBox.value!;
  stroke.value = null;
  surface.value?.releasePointerCapture(event.pointerId);
  if (current.tool === "draw") {
    const first = current.points[0];
    if (!current.points.some((point) => Math.hypot(point.x - first.x, point.y - first.y) >= 2))
      return;
    await addPageAnnotation(props.page - 1, {
      type: "draw",
      color: current.color,
      points: current.points.map(toPdf),
    });
  } else {
    if (box.width < 2 || box.height < 2) return;
    const [topLeft, topRight, bottomLeft, bottomRight] = rectCorners(box);
    await addPageAnnotation(props.page - 1, {
      type: current.tool,
      color: current.color,
      points: [toPdf(topLeft), toPdf(topRight), toPdf(bottomLeft), toPdf(bottomRight)],
    });
  }
}

/** Copy a saved note into a local draft so cancellation never mutates the document. */
function openNote(note: StickyNote): void {
  noteDraft.value = { id: note.id, point: note.point, text: note.text, color: note.color };
}

/** Create or update a note, keeping its draft open when the store reports a failure. */
async function saveNote(): Promise<void> {
  const draft = noteDraft.value;
  if (!draft || !draft.text.trim()) return;
  const saved = draft.id
    ? await editStickyNote(draft.id, draft.text, draft.color)
    : await addPageAnnotation(props.page - 1, {
        type: "sticky-note",
        point: draft.point,
        text: draft.text,
        color: draft.color,
      });
  if (saved) noteDraft.value = null;
}

/** Discard an unfinished stroke or note before Escape reaches global tool cancellation. */
function escape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (noteDraft.value || stroke.value) {
    noteDraft.value = null;
    stroke.value = null;
    event.stopPropagation();
  }
}
</script>

<template>
  <div v-if="viewport" class="annotation-layer" @keydown="escape">
    <svg
      ref="surface"
      class="annotation-surface"
      :class="{ active }"
      :viewBox="`0 0 ${viewport.width} ${viewport.height}`"
      :aria-label="`Annotate page ${page}`"
      @pointerdown.prevent="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="stroke = null"
      @lostpointercapture="stroke = null"
    >
      <template v-if="stroke && previewBox">
        <polyline
          v-if="stroke.tool === 'draw'"
          :points="stroke.points.map((p) => `${p.x},${p.y}`).join(' ')"
          fill="none"
          :stroke="stroke.color"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <rect
          v-else-if="stroke.tool === 'highlight'"
          v-bind="previewBox"
          :fill="stroke.color"
          fill-opacity="0.35"
        />
        <line
          v-else
          :x1="previewBox.x"
          :x2="previewBox.x + previewBox.width"
          :y1="previewBox.y + previewBox.height"
          :y2="previewBox.y + previewBox.height"
          :stroke="stroke.color"
          stroke-width="1.5"
        />
      </template>
    </svg>
    <AnnotationSelection
      :page="page"
      :viewport="viewport"
      :disabled="!!noteDraft"
      @edit-note="openNote"
    />
    <form
      v-if="noteDraft"
      class="note-popup"
      role="dialog"
      aria-label="Sticky note"
      :style="{ borderColor: noteDraft.color }"
      @submit.prevent="saveNote"
      @pointerdown.stop
    >
      <label
        >Sticky note
        <textarea
          v-model="noteDraft.text"
          aria-label="Note text"
          rows="4"
          autofocus
          :disabled="state.busy"
        />
      </label>
      <label class="note-color"
        >Note color
        <input
          type="color"
          v-model="noteDraft.color"
          aria-label="Note color"
          :disabled="state.busy"
        />
      </label>
      <div class="note-actions">
        <button type="button" @click="noteDraft = null" :disabled="state.busy">Cancel</button>
        <button type="submit" :disabled="state.busy || !noteDraft.text.trim()">Save note</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.annotation-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.annotation-surface {
  width: 100%;
  height: 100%;
  display: block;
}
.annotation-surface.active {
  pointer-events: auto;
  touch-action: none;
  cursor: crosshair;
}
.note-popup {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  width: 260px;
  max-width: calc(100% - 32px);
  padding: 12px;
  border: 2px solid;
  border-radius: 8px;
  background: #26272c;
  color: #e6e7ea;
  box-shadow: 0 4px 20px #0008;
  pointer-events: auto;
  z-index: 5;
  font-size: 13px;
}
.note-popup textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 8px 0;
  padding: 6px;
  resize: vertical;
  background: #1e1f24;
  color: inherit;
  border: 1px solid #555;
  border-radius: 4px;
  font: inherit;
}
.note-color {
  display: flex;
  align-items: center;
  gap: 8px;
}
.note-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.note-actions button {
  padding: 5px 10px;
  background: #2b4a76;
  border: 1px solid #3f6db3;
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
}
.note-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
