<script setup lang="ts">
import { reactive, watch } from "vue";
import { applyFormValues, state } from "../store";
import type { FormValues } from "../lib/edits";

const emit = defineEmits<{
  (e: "goto-page", page: number): void;
  (e: "close"): void;
}>();

const draft = reactive<FormValues>({});

watch(
  () => state.formFields,
  (fields) => {
    for (const k of Object.keys(draft)) delete draft[k];
    for (const f of fields) draft[f.name] = f.value;
  },
  { immediate: true },
);

/** Commit the local form draft; edits remain local until Apply Changes is pressed. */
function apply(): void {
  void applyFormValues(draft);
}
</script>

<template>
  <aside class="form-panel">
    <div class="panel-head">
      <h2>Form Fields</h2>
      <button title="Close panel" @click="emit('close')">✕</button>
    </div>

    <p v-if="!state.formFields.length" class="muted">
      No fillable form fields found in this document.
    </p>

    <div v-for="f in state.formFields" :key="f.name" class="field">
      <label
        class="field-name"
        :class="{ clickable: f.page >= 0 }"
        :title="f.page >= 0 ? `On page ${f.page + 1} — click to jump` : ''"
        @click="f.page >= 0 && emit('goto-page', f.page + 1)"
      >
        {{ f.name }}<span v-if="f.page >= 0" class="page-tag">p.{{ f.page + 1 }}</span>
      </label>

      <input v-if="f.type === 'text'" v-model="draft[f.name]" />
      <input v-else-if="f.type === 'checkbox'" type="checkbox" v-model="draft[f.name]" />
      <select v-else v-model="draft[f.name]">
        <option value="">—</option>
        <option v-for="o in f.options ?? []" :key="o" :value="o">{{ o }}</option>
      </select>
    </div>

    <button class="apply" @click="apply" :disabled="!state.formFields.length || state.busy">
      Apply Changes
    </button>
  </aside>
</template>

<style scoped>
.form-panel {
  width: 280px;
  flex-shrink: 0;
  background: #202125;
  border-left: 1px solid #2e3036;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 10px;
  overflow-y: auto;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-head h2 {
  margin: 0;
  font-size: 14px;
}

.panel-head button {
  background: none;
  border: none;
  color: #9aa0ab;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
}

.panel-head button:hover {
  background: #2c2e34;
  color: #e6e7ea;
}

.muted {
  color: #7d828e;
  font-size: 12px;
  margin: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-name {
  font-size: 12px;
  color: #9aa0ab;
  word-break: break-all;
}

.field-name.clickable {
  cursor: pointer;
}

.field-name.clickable:hover {
  color: #cfe3ff;
}

.page-tag {
  margin-left: 6px;
  background: #2b4a76;
  color: #cfe3ff;
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 10px;
}

input,
select {
  background: #1e1f24;
  border: 1px solid #3a3d45;
  color: #e6e7ea;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}

input[type="checkbox"] {
  width: auto;
  transform: scale(1.2);
}

.apply {
  margin-top: auto;
  background: #2b6cb0;
  color: #fff;
  border: 1px solid #3f83d4;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.apply:hover:not(:disabled) {
  background: #3278c4;
}

.apply:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
