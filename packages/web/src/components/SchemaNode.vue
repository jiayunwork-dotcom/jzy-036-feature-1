<script lang="ts">
// 与 <script setup> 并存：为递归自引用提供稳定组件名（生产构建后不依赖文件名推断）
export default { name: 'SchemaNode' };
</script>

<script setup lang="ts">
/**
 * 单个字段节点（递归渲染 object.children / array.item）。
 * 所有修改都直接在响应式 model 上就地完成，并通过 changed() 上抛，
 * 由顶层 StructureEditor 统一触发 syncFromModel 重建文本。
 */
import { computed } from 'vue';
import type { FieldNode } from '@engine/types';
import {
  addField,
  changeType,
  indentNode,
  moveNode,
  outdentNode,
  removeNode,
  updateNode,
} from '@engine/tree';
import { ALL_TYPES } from '@engine/types';

const props = defineProps<{
  root: FieldNode;
  node: FieldNode;
  depth: number;
  changed: () => void;
}>();

const isRoot = computed(() => props.depth === 0);
const isItem = computed(() => props.node.name === '$item');

function mutate(fn: () => void): void {
  fn();
  props.changed();
}

function onName(e: Event): void {
  const name = (e.target as HTMLInputElement).value;
  mutate(() => updateNode(props.root, props.node.id, { name }));
}
function onType(e: Event): void {
  const type = (e.target as HTMLSelectElement).value as FieldNode['type'];
  mutate(() => changeType(props.root, props.node.id, type));
}
function onTitle(e: Event): void {
  mutate(() => updateNode(props.root, props.node.id, { title: (e.target as HTMLInputElement).value }));
}
function onDescription(e: Event): void {
  mutate(() =>
    updateNode(props.root, props.node.id, { description: (e.target as HTMLInputElement).value }),
  );
}
function onRequired(e: Event): void {
  mutate(() =>
    updateNode(props.root, props.node.id, { required: (e.target as HTMLInputElement).checked }),
  );
}
function onMinLength(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  mutate(() => updateNode(props.root, props.node.id, { minLength: numOrUndef(raw) }));
}
function onMaxLength(e: Event): void {
  mutate(() => updateNode(props.root, props.node.id, { maxLength: numOrUndef((e.target as HTMLInputElement).value) }));
}
function onMinimum(e: Event): void {
  mutate(() => updateNode(props.root, props.node.id, { minimum: numOrUndef((e.target as HTMLInputElement).value) }));
}
function onMaximum(e: Event): void {
  mutate(() => updateNode(props.root, props.node.id, { maximum: numOrUndef((e.target as HTMLInputElement).value) }));
}
function onPattern(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  mutate(() => updateNode(props.root, props.node.id, { pattern: v || undefined }));
}
function onDefault(e: Event): void {
  const target = e.target as HTMLInputElement;
  let v: string | number | boolean | undefined = target.value;
  if (props.node.type === 'number' || props.node.type === 'integer') v = numOrUndef(target.value);
  if (props.node.type === 'boolean') v = target.checked;
  mutate(() => updateNode(props.root, props.node.id, { default: v === '' ? undefined : v }));
}

function numOrUndef(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function addChild(type: FieldNode['type']): void {
  mutate(() => addField(props.root, props.node.id, type));
}
function remove(): void {
  mutate(() => removeNode(props.root, props.node.id));
}
function up(): void {
  mutate(() => moveNode(props.root, props.node.id, -1));
}
function down(): void {
  mutate(() => moveNode(props.root, props.node.id, 1));
}
function indent(): void {
  mutate(() => indentNode(props.root, props.node.id));
}
function outdent(): void {
  mutate(() => outdentNode(props.root, props.node.id));
}
function onItemType(e: Event): void {
  const type = (e.target as HTMLSelectElement).value as FieldNode['type'];
  mutate(() => {
    if (!props.node.item) return;
    changeType(props.root, props.node.item.id, type);
  });
}

const enumText = computed({
  get: () => (props.node.enum ?? []).map(String).join(', '),
  set: (v: string) => {
    const parts = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    let values: (string | number | boolean)[] = parts;
    if (props.node.type === 'number' || props.node.type === 'integer') {
      values = parts.map(Number).filter((n) => Number.isFinite(n));
    }
    mutate(() => updateNode(props.root, props.node.id, { enum: values.length ? values : undefined }));
  },
});

function canIndent(): boolean {
  return !isRoot.value && !isItem.value;
}
</script>

<template>
  <div class="tree-node" :class="{ depth0: depth === 0 }">
    <div class="node-row">
      <input
        v-if="!isRoot && !isItem"
        class="name-input"
        :value="node.name"
        @change="onName"
        placeholder="字段名"
      />
      <strong v-else-if="isRoot">📋 根对象</strong>
      <span v-else class="hint">数组项</span>

      <select v-if="!isItem" :value="node.type" @change="onType" title="字段类型">
        <option v-for="t in ALL_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <span v-else class="type-tag">item: {{ node.item?.type ?? '?' }}</span>

      <span v-if="node.required && !isRoot" class="req-mark" title="必填">*</span>

      <span class="spacer" style="flex: 1" />
      <button v-if="node.type === 'object'" class="tiny" title="添加字符串字段" @click="addChild('string')">＋文本</button>
      <button v-if="node.type === 'object'" class="tiny" title="添加对象" @click="addChild('object')">＋对象</button>
      <button v-if="node.type === 'object'" class="tiny" title="添加数组" @click="addChild('array')">＋数组</button>
      <template v-if="!isRoot && !isItem">
        <button class="tiny" title="上移" @click="up">↑</button>
        <button class="tiny" title="下移" @click="down">↓</button>
        <button class="tiny" title="缩进（成为前一个对象的子字段）" :disabled="!canIndent()" @click="indent">→|</button>
        <button class="tiny" title="反缩进" @click="outdent">|←</button>
        <button class="tiny danger" title="删除字段" @click="remove">删除</button>
      </template>
    </div>

    <div class="node-detail">
      <div class="detail-grid">
        <label>标题</label>
        <input :value="node.title ?? ''" @change="onTitle" placeholder="展示给填写者的名称" />
        <template v-if="!isRoot">
          <label>必填</label>
          <label style="text-align: left">
            <input type="checkbox" :checked="!!node.required" @change="onRequired" /> 必填字段
          </label>
        </template>
        <template v-else>
          <span />
          <span />
        </template>
        <label>说明</label>
        <input class="span2" :value="node.description ?? ''" @change="onDescription" placeholder="字段描述（可选）" />

        <!-- string 约束 -->
        <template v-if="node.type === 'string'">
          <label>最小长度</label>
          <input type="number" min="0" :value="node.minLength ?? ''" @change="onMinLength" />
          <label>最大长度</label>
          <input type="number" min="0" :value="node.maxLength ?? ''" @change="onMaxLength" />
          <label>正则模式</label>
          <input class="span2" :value="node.pattern ?? ''" @change="onPattern" placeholder="例如 ^\d{6}$" />
          <label>枚举取值</label>
          <input class="span2" v-model="enumText" placeholder="逗号分隔，如：前端专场,后端专场,AI 专场" />
          <label>默认值</label>
          <input class="span2" :value="(node.default as string) ?? ''" @change="onDefault" />
        </template>

        <!-- number/integer 约束 -->
        <template v-if="node.type === 'number' || node.type === 'integer'">
          <label>最小值</label>
          <input type="number" :value="node.minimum ?? ''" @change="onMinimum" />
          <label>最大值</label>
          <input type="number" :value="node.maximum ?? ''" @change="onMaximum" />
          <label>枚举取值</label>
          <input class="span2" v-model="enumText" placeholder="逗号分隔数字，如：1,2,3" />
          <label>默认值</label>
          <input type="number" class="span2" :value="(node.default as number) ?? ''" @change="onDefault" />
        </template>

        <!-- boolean -->
        <template v-if="node.type === 'boolean'">
          <label>默认勾选</label>
          <label style="text-align: left">
            <input type="checkbox" :checked="!!node.default" @change="onDefault" /> 默认值
          </label>
        </template>

        <!-- array item 类型 -->
        <template v-if="node.type === 'array'">
          <label>项类型</label>
          <select :value="node.item?.type ?? 'string'" @change="onItemType">
            <option v-for="t in ALL_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </template>
      </div>
    </div>

    <!-- object 子字段 -->
    <template v-if="node.type === 'object'">
      <SchemaNode
        v-for="child in node.children"
        :key="child.id"
        :root="root"
        :node="child"
        :depth="depth + 1"
        :changed="changed"
      />
      <div v-if="!node.children || node.children.length === 0" class="hint" style="margin: 2px 0 8px 22px">
        （空对象：用上方「＋文本 / ＋对象 / ＋数组」添加字段）
      </div>
    </template>

    <!-- array item -->
    <template v-if="node.type === 'array' && node.item">
      <SchemaNode :root="root" :node="node.item" :depth="depth + 1" :changed="changed" />
    </template>
  </div>
</template>
