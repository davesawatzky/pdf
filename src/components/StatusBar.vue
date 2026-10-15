<script setup lang="ts">
import { state } from "../store";
</script>

<template>
  <div class="statusbar">
    <span v-if="state.error" class="error">{{ state.error }}</span>
    <span v-else>{{ state.status }}</span>
    <div class="right">
      <span v-if="state.selected.length">{{ state.selected.length }} selected</span>
      <span v-if="state.pageCount">{{ state.pageCount }} pages</span>
      <span>{{ state.fileName || "No document" }}</span>
    </div>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 12px;
  font-size: 12px;
  color: #9aa0ab;
  background: #232428;
  border-top: 1px solid #2e3036;
}

.error {
  color: #ff8fa3;
}

.right {
  display: flex;
  gap: 14px;
  white-space: nowrap;
}
</style>
