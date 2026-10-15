<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getPdfDoc, placePendingImage, selectPage, setCurrentPage, setZoom, state } from "../store";
import { pageSizeAtScale1, renderPage } from "../lib/pdfjs";
import AnnotationLayer from "./AnnotationLayer.vue";

const emit = defineEmits<{
  (e: "request-text", pos: { page: number; x: number; y: number }): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);
const slotEls = new Map<number, HTMLElement>(); // 1-based page → element
const rendered = new Map<number, string>(); // page → "version:zoom" key
const inflight = new Set<number>();
let visiblePages = new Set<number>();
let io: IntersectionObserver | null = null;
let scrollTicking = false;

/** Register the DOM slot for a one-based page, removing unmounted slots. */
function setSlotRef(element: unknown, page: number): void {
  if (element instanceof HTMLElement) slotEls.set(page, element);
  else slotEls.delete(page);
}

/** Observe mounted page slots with a pre-render margin around the scroll viewport. */
function setupObserver(): void {
  io?.disconnect();
  const root = scrollEl.value;
  if (!root) return;
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isFinite(page)) continue;
        if (entry.isIntersecting) visiblePages.add(page);
        else visiblePages.delete(page);
      }
      void renderVisible();
    },
    { root, rootMargin: "400px 0px" },
  );
  for (const el of slotEls.values()) io.observe(el);
}

/** Render uncached visible pages once per version/zoom, retrying obsolete in-flight renders on completion. */
async function renderVisible(): Promise<void> {
  const pdf = getPdfDoc();
  if (!pdf) return;
  const key = `${state.version}:${state.zoom}`;
  for (const page of visiblePages) {
    if (rendered.get(page) === key || inflight.has(page)) continue;
    const slot = slotEls.get(page);
    const canvas = slot?.querySelector("canvas");
    if (!slot || !(canvas instanceof HTMLCanvasElement)) continue;
    inflight.add(page);
    try {
      await renderPage(pdf, page, state.zoom, canvas);
      rendered.set(page, key);
    } catch (err) {
      console.error(`Failed to render page ${page}`, err);
    } finally {
      inflight.delete(page);
      if (key !== `${state.version}:${state.zoom}`) void renderVisible();
    }
  }
}

/** Track which page is centered in the viewport. */
function onScroll(): void {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    const root = scrollEl.value;
    if (!root || !state.pageCount) return;
    const rect = root.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    let nearestPage = state.currentPage;
    let nearestDistance = Infinity;
    for (const [page, element] of slotEls) {
      const bounds = element.getBoundingClientRect();
      const distance = Math.min(Math.abs(bounds.top - midY), Math.abs(bounds.bottom - midY));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = page;
      }
    }
    setCurrentPage(nearestPage);
  });
}

/** Convert a click on the canvas to PDF points and act on the current mode. */
async function onCanvasClick(e: MouseEvent, page: number): Promise<void> {
  if (state.mode === "view") {
    selectPage(page - 1, e.ctrlKey || e.metaKey);
    return;
  }
  const pdf = getPdfDoc();
  if (!pdf) return;
  const canvas = e.currentTarget as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const xPt = (e.clientX - rect.left) / state.zoom;
  const yTopPt = (e.clientY - rect.top) / state.zoom;
  const size = await pageSizeAtScale1(pdf, page);
  const yPt = size.height - yTopPt; // PDF origin is bottom-left.
  if (state.mode === "place-image") {
    void placePendingImage(page - 1, xPt, yPt);
  } else if (state.mode === "place-text") {
    emit("request-text", { page: page - 1, x: xPt, y: yPt });
  }
}

/** Fit the first page's displayed width into the viewer, leaving room for padding. */
async function fitWidth(): Promise<void> {
  const pdf = getPdfDoc();
  const root = scrollEl.value;
  if (!pdf || !root) return;
  const availableWidth = Math.max(200, root.clientWidth - 56);
  const size = await pageSizeAtScale1(pdf, 1);
  setZoom(availableWidth / size.width);
}

/** Smoothly scroll the mounted slot for a one-based viewer page into view. */
function scrollToPage(page: number): void {
  slotEls.get(page)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

watch(
  () => [state.zoom, state.version],
  () => {
    rendered.clear();
    void renderVisible();
  },
);

watch(
  () => state.pageCount,
  async () => {
    await nextTick();
    visiblePages = new Set();
    setupObserver();
    rendered.clear();
    void renderVisible();
  },
);

onMounted(async () => {
  await nextTick();
  setupObserver();
  void renderVisible();
  scrollEl.value?.addEventListener("scroll", onScroll);
});

onBeforeUnmount(() => {
  io?.disconnect();
  scrollEl.value?.removeEventListener("scroll", onScroll);
});

defineExpose({ scrollToPage, fitWidth });
</script>

<template>
  <div ref="scrollEl" class="viewer" :class="{ placing: state.mode !== 'view' }">
    <div v-if="state.bytes" class="pages">
      <div
        v-for="p in state.pageCount"
        :key="p"
        class="page-slot"
        :data-page="p"
        :ref="(el) => setSlotRef(el, p)"
      >
        <div class="page-surface">
          <canvas @click="onCanvasClick($event, p)" />
          <AnnotationLayer :page="p" />
        </div>
        <div class="num">{{ p }}</div>
      </div>
    </div>
    <div v-else class="empty">
      <p>No document open.</p>
      <p class="muted">Use “Open…” in the toolbar to load a PDF.</p>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  flex: 1;
  overflow: auto;
  background: #17181c;
  position: relative;
}

.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 20px 0 60px;
  width: max-content;
  min-width: 100%;
  margin: 0 auto;
}

.page-slot {
  position: relative;
}

.page-surface {
  position: relative;
}

.page-slot canvas {
  display: block;
  background: #fff;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.5);
  border-radius: 2px;
}

.viewer.placing .page-slot canvas {
  cursor: crosshair;
}

.page-slot .num {
  text-align: center;
  font-size: 11px;
  color: #8b909c;
  margin-top: 4px;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #c8ccd4;
  font-size: 15px;
}

.empty .muted {
  color: #7d828e;
  font-size: 13px;
}
</style>
