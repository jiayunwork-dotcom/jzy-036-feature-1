<script setup lang="ts">
/**
 * 可视化结构编辑区：结构树外壳。
 * 文本非法时仍可编辑结构（model 是最近一次合法模型）；一旦编辑结构，
 * onModelChanged 会以结构为准重新生成文本，两侧重新接上。
 */
import { session, onModelChanged } from '../stores/syncSession';
import SchemaNode from './SchemaNode.vue';
import { addField, addRefField } from '@engine/tree';
import { fragmentsState } from '../stores/fragments';

function changed(): void {
  onModelChanged();
}

function addTop(type: 'string' | 'object' | 'array'): void {
  addField(session.model, null, type);
  onModelChanged();
}

function addTopRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key) return;
  addRefField(session.model, null, key);
  (e.target as HTMLSelectElement).value = '';
  onModelChanged();
}
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      🏗️ 结构编辑
      <span class="hint">增删字段 / 引用片段 / 改类型与约束</span>
      <span class="spacer" />
      <button class="tiny" @click="addTop('string')">＋文本字段</button>
      <button class="tiny" @click="addTop('object')">＋对象</button>
      <button class="tiny" @click="addTop('array')">＋数组</button>
      <select
        v-if="fragmentsState.fragments.length"
        class="tiny"
        title="添加片段引用字段（引用唯一定义，不展开复制）"
        @change="addTopRef"
      >
        <option value="">＋引用片段…</option>
        <option v-for="f in fragmentsState.fragments" :key="f.key" :value="f.key">
          🔗 {{ f.title || f.key }}
        </option>
      </select>
    </div>
    <div class="panel-body" style="padding: 10px 10px 16px">
      <SchemaNode :root="session.model" :node="session.model" :depth="0" :changed="changed" />
    </div>
  </section>
</template>
