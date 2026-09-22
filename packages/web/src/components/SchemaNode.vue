<script lang="ts">
// 与 <script setup> 并存：为递归自引用提供稳定组件名（生产构建后不依赖文件名推断）
export default { name: 'SchemaNode' };
</script>

<script setup lang="ts">
/**
 * 单个结构节点（递归渲染 object.children / array.item）。
 * 节点分两种：
 *  - 内嵌定义（FieldNode）：原有的类型/约束编辑能力，另可「转换为片段引用」；
 *  - 片段引用（RefNode）：醒目的引用外观，只可改名/必填/跳转片段/还原内嵌/删除，
 *    不就地展开片段内容（唯一定义在片段库里）。
 * 所有修改都直接在响应式 model 上就地完成，并通过 changed() 上抛。
 */
import { computed } from 'vue';
import type { FieldNode, RefNode, StructureNode } from '@engine/types';
import { isRef } from '@engine/types';
import {
  addField,
  addRefField,
  changeType,
  convertToRef,
  indentNode,
  inlineRefNode,
  moveNode,
  outdentNode,
  removeNode,
  setArrayItemRef,
  updateNode,
} from '@engine/tree';
import { ALL_TYPES } from '@engine/types';
import { session } from '../stores/syncSession';
import { fragmentsState } from '../stores/fragments';

const props = defineProps<{
  root: FieldNode;
  node: StructureNode;
  depth: number;
  changed: () => void;
}>();

const isRoot = computed(() => props.depth === 0);
const isItem = computed(() => props.node.name === '$item');
const refNode = computed<RefNode | null>(() => (isRef(props.node) ? props.node : null));
const fieldNode = computed<FieldNode | null>(() => (isRef(props.node) ? null : props.node));

const fragmentChoices = computed(() =>
  fragmentsState.fragments.map((f) => ({ key: f.key, title: f.title || f.key })),
);

/** 引用的片段是否存活（悬空时给出红色提示，但结构区仍保留该引用节点） */
const refTarget = computed(() =>
  refNode.value ? session.fragments.get(refNode.value.ref) : undefined,
);
const refDangling = computed(() => refNode.value !== null && refTarget.value === undefined);

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
  if (fieldNode.value?.type === 'number' || fieldNode.value?.type === 'integer') v = numOrUndef(target.value);
  if (fieldNode.value?.type === 'boolean') v = target.checked;
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
function addChildRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key) return;
  mutate(() => addRefField(props.root, props.node.id, key));
  (e.target as HTMLSelectElement).value = '';
}
function addTopRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key) return;
  mutate(() => addRefField(props.root, null, key));
  (e.target as HTMLSelectElement).value = '';
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
    if (!fieldNode.value?.item || isRef(fieldNode.value.item)) return;
    changeType(props.root, fieldNode.value.item.id, type);
  });
}
function onItemRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key || !fieldNode.value) return;
  mutate(() => setArrayItemRef(props.root, fieldNode.value.id, key));
  (e.target as HTMLSelectElement).value = '';
}

/** 内嵌字段 -> 片段引用（保留字段名与必填） */
function onConvertToRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key) return;
  mutate(() => convertToRef(props.root, props.node.id, key));
  (e.target as HTMLSelectElement).value = '';
}

/** 数组 item 若是内嵌字段，也可转引用 */
function onConvertItemToRef(e: Event): void {
  const key = (e.target as HTMLSelectElement).value;
  if (!key || !fieldNode.value?.item) return;
  mutate(() => convertToRef(props.root, fieldNode.value.item.id, key));
  (e.target as HTMLSelectElement).value = '';
}

/** 引用 -> 还原为内嵌（取片段当前定义生成独立副本，从此脱离复用） */
function onInline(): void {
  if (!refNode.value || !refTarget.value) return;
  mutate(() => inlineRefNode(props.root, props.node.id, refTarget.value.root));
}

const enumText = computed({
  get: () => (fieldNode.value?.enum ?? []).map(String).join(', '),
  set: (v: string) => {
    const node = fieldNode.value;
    if (!node) return;
    const parts = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    let values: (string | number | boolean)[] = parts;
    if (node.type === 'number' || node.type === 'integer') {
      values = parts.map(Number).filter((n) => Number.isFinite(n));
    }
    mutate(() => updateNode(props.root, props.node.id, { enum: values.length ? values : undefined }));
  },
});

function canIndent(): boolean {
  return !isRoot.value && !isItem.value;
}

defineExpose({ addTopRef });
</script>

<template>
  <div class="tree-node" :class="{ depth0: depth === 0, 'ref-node': !!refNode }">
    <!-- ============ 片段引用节点 ============ -->
    <template v-if="refNode">
      <div class="node-row ref-row">
        <input
          v-if="!isRoot && !isItem"
          class="name-input"
          :value="refNode.name"
          @change="onName"
          placeholder="字段名"
        />
        <span v-else class="hint">数组项引用</span>
        <span class="ref-badge" :class="{ dangling: refDangling }" title="片段引用：指向片段库中唯一定义">
          🔗 片段引用
        </span>
        <strong class="ref-key">{{ refNode.ref }}</strong>
        <span v-if="refTarget" class="hint">{{ refTarget.title || refNode.ref }}（{{ refTarget.root.type }}）</span>
        <span v-else class="ref-dangling-text">片段不存在或已删除（悬空引用）</span>

        <span v-if="refNode.required && !isRoot" class="req-mark" title="必填">*</span>
        <span class="spacer" style="flex: 1" />
        <template v-if="!isRoot && !isItem">
          <button class="tiny" title="上移" @click="up">↑</button>
          <button class="tiny" title="下移" @click="down">↓</button>
          <button class="tiny" title="缩进" :disabled="!canIndent()" @click="indent">→|</button>
          <button class="tiny" title="反缩进" @click="outdent">|←</button>
        </template>
        <button class="tiny" :disabled="refDangling" title="把片段当前定义复制为独立内嵌字段（脱离复用）" @click="onInline">
          还原为内嵌
        </button>
        <button class="tiny danger" title="删除引用（不影响片段本身）" @click="remove">删除</button>
      </div>
      <div class="node-detail ref-detail">
        <div class="detail-grid">
          <label>必填</label>
          <label style="text-align: left">
            <input type="checkbox" :checked="!!refNode.required" @change="onRequired" /> 引用处必填
          </label>
          <label>片段 key</label>
          <code>{{ refNode.ref }}</code>
        </div>
        <div class="hint" style="margin-top: 4px">
          引用处不展开片段内容；控件、预览与校验按片段<strong>当前定义</strong>穿透生效。
        </div>
      </div>
    </template>

    <!-- ============ 内嵌定义节点（原有能力） ============ -->
    <template v-else-if="fieldNode">
      <div class="node-row">
        <input
          v-if="!isRoot && !isItem"
          class="name-input"
          :value="fieldNode.name"
          @change="onName"
          placeholder="字段名"
        />
        <strong v-else-if="isRoot">📋 根对象</strong>
        <span v-else class="hint">数组项</span>

        <select v-if="!isItem" :value="fieldNode.type" @change="onType" title="字段类型">
          <option v-for="t in ALL_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
        <span v-else class="type-tag">item: {{ fieldNode.item?.type ?? '?' }}</span>

        <span v-if="fieldNode.required && !isRoot" class="req-mark" title="必填">*</span>

        <span class="spacer" style="flex: 1" />
        <button v-if="fieldNode.type === 'object'" class="tiny" title="添加字符串字段" @click="addChild('string')">＋文本</button>
        <button v-if="fieldNode.type === 'object'" class="tiny" title="添加对象" @click="addChild('object')">＋对象</button>
        <button v-if="fieldNode.type === 'object'" class="tiny" title="添加数组" @click="addChild('array')">＋数组</button>
        <select
          v-if="fieldNode.type === 'object' && fragmentChoices.length"
          class="tiny add-ref-select"
          title="添加片段引用字段"
          @change="addChildRef"
        >
          <option value="">＋引用片段…</option>
          <option v-for="f in fragmentChoices" :key="f.key" :value="f.key">🔗 {{ f.title }}</option>
        </select>
        <template v-if="!isRoot && !isItem">
          <button class="tiny" title="上移" @click="up">↑</button>
          <button class="tiny" title="下移" @click="down">↓</button>
          <button class="tiny" title="缩进（成为前一个对象的子字段）" :disabled="!canIndent()" @click="indent">→|</button>
          <button class="tiny" title="反缩进" @click="outdent">|←</button>
          <!-- 内嵌 -> 引用：转换后原有定义被片段唯一定义取代 -->
          <select
            class="tiny convert-ref-select"
            title="把该字段转换为对已有片段的引用"
            :disabled="!fragmentChoices.length"
            @change="onConvertToRef"
          >
            <option value="">转为引用…</option>
            <option v-for="f in fragmentChoices" :key="f.key" :value="f.key">🔗 {{ f.title }}</option>
          </select>
          <button class="tiny danger" title="删除字段" @click="remove">删除</button>
        </template>
      </div>

      <div class="node-detail">
        <div class="detail-grid">
          <label>标题</label>
          <input :value="fieldNode.title ?? ''" @change="onTitle" placeholder="展示给填写者的名称" />
          <template v-if="!isRoot">
            <label>必填</label>
            <label style="text-align: left">
              <input type="checkbox" :checked="!!fieldNode.required" @change="onRequired" /> 必填字段
            </label>
          </template>
          <template v-else>
            <span />
            <span />
          </template>
          <label>说明</label>
          <input class="span2" :value="fieldNode.description ?? ''" @change="onDescription" placeholder="字段描述（可选）" />

          <!-- string 约束 -->
          <template v-if="fieldNode.type === 'string'">
            <label>最小长度</label>
            <input type="number" min="0" :value="fieldNode.minLength ?? ''" @change="onMinLength" />
            <label>最大长度</label>
            <input type="number" min="0" :value="fieldNode.maxLength ?? ''" @change="onMaxLength" />
            <label>正则模式</label>
            <input class="span2" :value="fieldNode.pattern ?? ''" @change="onPattern" placeholder="例如 ^\d{6}$" />
            <label>枚举取值</label>
            <input class="span2" v-model="enumText" placeholder="逗号分隔，如：前端专场,后端专场,AI 专场" />
            <label>默认值</label>
            <input class="span2" :value="(fieldNode.default as string) ?? ''" @change="onDefault" />
          </template>

          <!-- number/integer 约束 -->
          <template v-if="fieldNode.type === 'number' || fieldNode.type === 'integer'">
            <label>最小值</label>
            <input type="number" :value="fieldNode.minimum ?? ''" @change="onMinimum" />
            <label>最大值</label>
            <input type="number" :value="fieldNode.maximum ?? ''" @change="onMaximum" />
            <label>枚举取值</label>
            <input class="span2" v-model="enumText" placeholder="逗号分隔数字，如：1,2,3" />
            <label>默认值</label>
            <input type="number" class="span2" :value="(fieldNode.default as number) ?? ''" @change="onDefault" />
          </template>

          <!-- boolean -->
          <template v-if="fieldNode.type === 'boolean'">
            <label>默认勾选</label>
            <label style="text-align: left">
              <input type="checkbox" :checked="!!fieldNode.default" @change="onDefault" /> 默认值
            </label>
          </template>

          <!-- array item 类型 -->
          <template v-if="fieldNode.type === 'array'">
            <label>项类型</label>
            <template v-if="fieldNode.item && !isRef(fieldNode.item)">
              <select :value="fieldNode.item.type" @change="onItemType">
                <option v-for="t in ALL_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </template>
            <span v-else-if="fieldNode.item && isRef(fieldNode.item)" class="hint">
              🔗 引用片段「{{ fieldNode.item.ref }}」
            </span>
            <span v-else class="hint">未设置</span>

            <!-- item：内嵌类型可转引用；引用类型在递归节点里还原 -->
            <template v-if="fieldNode.item && !isRef(fieldNode.item) && fragmentChoices.length">
              <label>项引用</label>
              <select @change="onConvertItemToRef">
                <option value="">数组项转为片段引用…</option>
                <option v-for="f in fragmentChoices" :key="f.key" :value="f.key">🔗 {{ f.title }}</option>
              </select>
            </template>
            <template v-else>
              <span />
              <span />
            </template>
          </template>
        </div>
      </div>

      <!-- object 子字段（含引用节点） -->
      <template v-if="fieldNode.type === 'object'">
        <SchemaNode
          v-for="child in fieldNode.children"
          :key="child.id"
          :root="root"
          :node="child"
          :depth="depth + 1"
          :changed="changed"
        />
        <div v-if="!fieldNode.children || fieldNode.children.length === 0" class="hint" style="margin: 2px 0 8px 22px">
          （空对象：用上方「＋文本 / ＋对象 / ＋数组 / ＋引用片段」添加字段）
        </div>
      </template>

      <!-- array item（可能是内嵌字段，也可能是片段引用） -->
      <template v-if="fieldNode.type === 'array' && fieldNode.item">
        <SchemaNode :root="root" :node="fieldNode.item" :depth="depth + 1" :changed="changed" />
      </template>
    </template>
  </div>
</template>
