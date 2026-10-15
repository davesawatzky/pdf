<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { selectAnnotation, state, transformPageAnnotation } from "../store";
import type { AnnotationInfo, AnnotationRect, Point, StickyNote } from "../lib/annotations";
import type { pageViewportAtScale1 } from "../lib/pdfjs";
import {
  clamp,
  pointBounds,
  pointerToViewport,
  rectCorners,
  rectTransform,
  resizeRect,
  sameRect,
  toViewportPoint,
} from "../lib/geometry";
import type { ResizeHandle } from "../lib/geometry";

const props = defineProps<{
  page: number;
  viewport: Awaited<ReturnType<typeof pageViewportAtScale1>>;
  disabled: boolean;
}>();
const emit = defineEmits<{ "edit-note": [note: StickyNote] }>();
const surface = ref<SVGSVGElement | null>(null);
const modifier = ref(false);
const drag = ref<{
  id: string;
  pointer: number;
  start: Point;
  from: AnnotationRect;
  to: AnnotationRect;
  handle: ResizeHandle | null;
  target: Element;
} | null>(null);
const annotations = computed(() =>
  state.annotations.filter((annotation) => annotation.page === props.page - 1),
);
const notes = computed(() => state.stickyNotes.filter((note) => note.page === props.page - 1));
const selected = computed(() =>
  annotations.value.find((annotation) => annotation.id === state.selectedAnnotation),
);
const selectedNote = computed(() =>
  notes.value.find((note) => note.id === state.selectedAnnotation),
);
const canSelect = computed(() => state.mode === "view" || modifier.value);
const box = computed(
  () => drag.value?.to ?? (selected.value ? displayBounds(selected.value) : null),
);
const handles = computed(() => {
  if (!box.value || selected.value?.type === "sticky-note") return [];
  const { x, y, width, height } = box.value;
  return [
    { name: "nw", x, y },
    { name: "n", x: x + width / 2, y },
    { name: "ne", x: x + width, y },
    { name: "e", x: x + width, y: y + height / 2 },
    { name: "se", x: x + width, y: y + height },
    { name: "s", x: x + width / 2, y: y + height },
    { name: "sw", x, y: y + height },
    { name: "w", x, y: y + height / 2 },
  ] satisfies { name: ResizeHandle; x: number; y: number }[];
});

/** Project a stored PDF point into this page's scale-one display space. */
function toView(point: Point): Point {
  return toViewportPoint(props.viewport, point);
}

/** Compute display bounds; keep note icons upright and at a fixed CSS size. */
function displayBounds(annotation: AnnotationInfo): AnnotationRect {
  if (annotation.type === "sticky-note") {
    const note = notes.value.find((candidate) => candidate.id === annotation.id);
    const anchor = toView(
      note?.point ?? { x: annotation.rect.x, y: annotation.rect.y + annotation.rect.height },
    );
    const size = 24 / state.zoom;
    return {
      x: clamp(anchor.x, 0, props.viewport.width - size),
      y: clamp(anchor.y, 0, props.viewport.height - size),
      width: size,
      height: size,
    };
  }
  const bounds = pointBounds(rectCorners(annotation.rect).map(toView));
  return {
    ...bounds,
    width: Math.max(0.001, bounds.width),
    height: Math.max(0.001, bounds.height),
  };
}

/** Build SVG hit geometry from actual markup paths, falling back to the annotation rectangle. */
function hitPath(annotation: AnnotationInfo): string {
  if (!annotation.paths.length) {
    const { x, y, width, height } = displayBounds(annotation);
    return `M${x} ${y}h${width}v${height}h${-width}Z`;
  }
  return annotation.paths
    .map((path) => {
      const points = path.map(toView);
      const ordered =
        annotation.type === "highlight"
          ? [points[0], points[1], points[3], points[2]]
          : annotation.type === "underline"
            ? [points[2], points[3]]
            : points;
      return (
        ordered.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ") +
        (annotation.type === "highlight" ? "Z" : "")
      );
    })
    .join(" ");
}

/** Select on the first click; capture subsequent drags on the original target so note double-clicks work. */
function begin(
  event: PointerEvent,
  annotation: AnnotationInfo,
  handle: ResizeHandle | null = null,
): void {
  if (event.button !== 0 || props.disabled || state.busy) return;
  const target = event.currentTarget;
  if (!(target instanceof Element)) return;
  surface.value?.focus({ preventScroll: true });
  if (state.selectedAnnotation !== annotation.id) {
    selectAnnotation(annotation.id);
    return;
  }
  const from = displayBounds(annotation);
  drag.value = {
    id: annotation.id,
    pointer: event.pointerId,
    start: pointerToViewport(event, surface.value!, props.viewport),
    from,
    to: { ...from },
    handle,
    target,
  };
  target.setPointerCapture?.(event.pointerId);
}

/** Update the display-only move/resize preview for the captured pointer. */
function move(event: PointerEvent): void {
  const current = drag.value;
  if (!current || current.pointer !== event.pointerId) return;
  const point = pointerToViewport(event, surface.value!, props.viewport);
  const { from, handle } = current;
  if (!handle) {
    current.to = {
      ...from,
      x: clamp(from.x + point.x - current.start.x, 0, props.viewport.width - from.width),
      y: clamp(from.y + point.y - current.start.y, 0, props.viewport.height - from.height),
    };
    return;
  }
  current.to = resizeRect(from, handle, point, 4 / state.zoom);
}

/** Release capture and commit a changed preview as a PDF-space transform; no-op clicks leave bytes intact. */
async function finish(event: PointerEvent): Promise<void> {
  const current = drag.value;
  if (!current || current.pointer !== event.pointerId) return;
  move(event);
  drag.value = null;
  current.target.releasePointerCapture?.(event.pointerId);
  if (sameRect(current.from, current.to)) return;
  await transformPageAnnotation(
    current.id,
    rectTransform(props.viewport, current.from, current.to),
  );
}

/** Position a note icon relative to the page, including its live drag preview. */
function noteStyle(note: StickyNote): Record<string, string> {
  const annotation = annotations.value.find((candidate) => candidate.id === note.id);
  if (!annotation) return {};
  const bounds = drag.value?.id === note.id ? drag.value.to : displayBounds(annotation);
  return {
    left: `${(bounds.x / props.viewport.width) * 100}%`,
    top: `${(bounds.y / props.viewport.height) * 100}%`,
  };
}

/** Route a note icon's pointer event through the same selection and move interaction as marks. */
function noteDown(event: PointerEvent, note: StickyNote): void {
  const annotation = annotations.value.find((candidate) => candidate.id === note.id);
  if (annotation) begin(event, annotation);
}

/** Enable annotation selection while a creation tool is active and Ctrl or Meta is held. */
function keyModifier(event: KeyboardEvent): void {
  modifier.value = event.ctrlKey || event.metaKey;
}
/** Cancel transient gestures and modifier state when the window loses focus. */
function reset(): void {
  modifier.value = false;
  drag.value = null;
}
onMounted(() => {
  window.addEventListener("keydown", keyModifier);
  window.addEventListener("keyup", keyModifier);
  window.addEventListener("blur", reset);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", keyModifier);
  window.removeEventListener("keyup", keyModifier);
  window.removeEventListener("blur", reset);
});
watch(
  () => [state.version, state.mode, state.zoom, state.selectedAnnotation],
  () => {
    drag.value = null;
  },
);
</script>

<template>
  <div
    class="annotation-selection"
    :class="{ dragging: drag }"
    @pointermove="move"
    @pointerup="finish"
    @pointercancel="drag = null"
    @lostpointercapture="drag = null"
  >
    <svg
      ref="surface"
      class="annotation-selection-surface"
      tabindex="-1"
      :viewBox="`0 0 ${viewport.width} ${viewport.height}`"
    >
      <path
        v-for="annotation in annotations.filter((item) => item.type !== 'sticky-note')"
        :key="annotation.id"
        class="annotation-hit"
        :data-annotation-id="annotation.id"
        :aria-label="`Select ${annotation.type} annotation`"
        :d="hitPath(annotation)"
        :fill="annotation.type === 'highlight' ? 'transparent' : 'none'"
        stroke="transparent"
        :stroke-width="Math.max(10 / state.zoom, 2)"
        :style="{
          pointerEvents:
            !disabled && (canSelect || state.selectedAnnotation === annotation.id) ? 'all' : 'none',
          cursor: state.selectedAnnotation === annotation.id ? 'grab' : 'pointer',
        }"
        @pointerdown.stop.prevent="begin($event, annotation)"
      />
      <g v-if="selected && box && !disabled" class="annotation-selection-box">
        <rect
          class="selection-outline"
          v-bind="box"
          fill="transparent"
          :stroke-width="1 / state.zoom"
          @pointerdown.stop.prevent="begin($event, selected)"
        />
        <rect
          v-for="handle in handles"
          :key="handle.name"
          class="resize-handle"
          :data-handle="handle.name"
          :x="handle.x - 4 / state.zoom"
          :y="handle.y - 4 / state.zoom"
          :width="8 / state.zoom"
          :height="8 / state.zoom"
          :stroke-width="1 / state.zoom"
          :style="{
            cursor: ['n', 's'].includes(handle.name)
              ? 'ns-resize'
              : ['e', 'w'].includes(handle.name)
                ? 'ew-resize'
                : ['ne', 'sw'].includes(handle.name)
                  ? 'nesw-resize'
                  : 'nwse-resize',
          }"
          @pointerdown.stop.prevent="begin($event, selected, handle.name)"
        />
      </g>
    </svg>
    <button
      v-for="note in notes"
      :key="note.id"
      class="note-icon"
      :class="{ selected: state.selectedAnnotation === note.id }"
      :style="{ ...noteStyle(note), backgroundColor: note.color }"
      :aria-label="`Sticky note: ${note.text}`"
      :title="`${note.text} (double-click to edit)`"
      :disabled="state.busy || disabled"
      @pointerdown.stop.prevent="noteDown($event, note)"
      @click.stop="selectAnnotation(note.id)"
      @dblclick.stop="emit('edit-note', note)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 3h16v12l-6 6H4Z M14 21v-6h6 M8 8h8 M8 12h5" />
      </svg>
    </button>
    <button
      v-if="selectedNote && box && !disabled"
      class="edit-note-button"
      :disabled="state.busy"
      :style="{
        left: `${(box.x / viewport.width) * 100}%`,
        top: `max(0px, calc(${(box.y / viewport.height) * 100}% - 30px))`,
      }"
      @click.stop="emit('edit-note', selectedNote)"
    >
      Edit note
    </button>
  </div>
</template>

<style scoped>
.annotation-selection {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.annotation-selection-surface {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
  touch-action: none;
  outline: none;
}
.selection-outline {
  stroke: #267bdb;
  stroke-dasharray: 4 2;
  pointer-events: all;
  cursor: grab;
}
.resize-handle {
  fill: #fff;
  stroke: #267bdb;
  pointer-events: all;
}
.dragging .selection-outline,
.dragging .annotation-hit,
.dragging .note-icon {
  cursor: grabbing !important;
}
.note-icon {
  position: absolute;
  width: 24px;
  height: 24px;
  padding: 2px;
  border: 1px solid #555;
  border-radius: 3px;
  pointer-events: auto;
  color: #161616;
  cursor: pointer;
}
.note-icon.selected {
  cursor: grab;
  outline: 2px solid #267bdb;
  outline-offset: 2px;
}
.note-icon svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.edit-note-button {
  position: absolute;
  padding: 4px 8px;
  background: #2b4a76;
  color: #fff;
  border: 1px solid #3f6db3;
  border-radius: 4px;
  pointer-events: auto;
  cursor: pointer;
  white-space: nowrap;
}
</style>
