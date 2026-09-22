<script lang="ts">
// 递归组件：预览中的 object 分组与 array item 都通过 <FormField> 自引用渲染
export default { name: 'FormField' };
</script>

<script setup lang="ts">
/**
 * 预览表单中的单个字段（递归 object / array）。
 * 数据通过 deepGet/deepSet 按路径读写整棵响应式 data；
 * 校验错误按 loc（如 companions.0.zipCode）定位展示。
 */
import { computed } from 'vue';
import type { FieldNode } from '@engine/types';
import { deepGet, deepSet, formatLoc, initItemData, type FormData, type PathSeg } from '@engine/validate';

const props = defineProps<{
  node: FieldNode;
  path: PathSeg[];
  data: FormData;
  errors: Record<string, string>;
  onBlur: (path: PathSeg[]) => void;
}>();

const loc = computed(() => formatLoc(props.path));
const error = computed(() => props.errors[loc.value]);
const value = computed(() => deepGet(props.data, props.path));

function setValue(raw: unknown): void {
  deepSet(props.data as Record<string, unknown>, props.path, raw);
}

function onInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  if (props.node.type === 'number' || props.node.type === 'integer') {
    setValue(target.value === '' ? undefined : Number(target.value));
  } else {
    setValue(target.value);
  }
  clearErr();
}

function onCheckbox(e: Event): void {
  setValue((e.target as HTMLInputElement).checked);
  clearErr();
}

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  setValue(v === '' ? undefined : v);
  clearErr();
}

function clearErr(): void {
  if (props.errors[loc.value]) delete props.errors[loc.value];
}

function blur(): void {
  props.onBlur(props.path);
}

const title = computed(() => props.node.title || props.node.name);

/* ---- 数组操作 ---- */
const arr = computed<unknown[]>(() => {
  const v = value.value;
  if (!Array.isArray(v)) return [];
  return v;
});

function ensureArray(): unknown[] {
  let v = deepGet(props.data, props.path);
  if (!Array.isArray(v)) {
    v = [];
    deepSet(props.data as Record<string, unknown>, props.path, v);
  }
  return v as unknown[];
}

function addItem(): void {
  ensureArray().push(initItemData(props.node.item!));
  clearErr();
  props.onBlur(props.path);
}

function removeItem(index: number): void {
  ensureArray().splice(index, 1);
  props.onBlur(props.path);
}

const isScalarItem = computed(() => props.node.item && props.node.item.type !== 'object');
</script>

<template>
  <!-- 对象分组 -->
  <fieldset v-if="node.type === 'object'" class="field-group">
    <legend class="group-title">
      {{ node.title || (path.length === 0 ? '' : node.name) }}
      <span v-if="node.description" class="desc">{{ node.description }}</span>
    </legend>
    <FormField
      v-for="child in node.children"
      :key="child.id"
      :node="child"
      :path="[...path, child.name]"
      :data="data"
      :errors="errors"
      :on-blur="onBlur"
    />
  </fieldset>

  <!-- 数组：可增删的重复项 -->
  <div v-else-if="node.type === 'array'" class="field-line">
    <label>
      {{ title }}
      <span v-if="node.required" class="req-mark"> *</span>
      <span v-if="node.description" class="desc">{{ node.description }}</span>
    </label>
    <div v-for="(_, i) in arr" :key="i" class="array-item">
      <div class="array-item-head">
        <strong>#{{ i + 1 }}</strong>
        <span class="spacer" />
        <button type="button" class="tiny danger" @click="removeItem(i)">删除该项</button>
      </div>
      <!-- 标量数组项：直接一个控件 -->
      <template v-if="isScalarItem && node.item">
        <FormField
          :node="node.item"
          :path="[...path, i]"
          :data="data"
          :errors="errors"
          :on-blur="onBlur"
        />
      </template>
      <!-- 对象数组项：平铺其子字段 -->
      <template v-else-if="node.item">
        <FormField
          v-for="child in node.item.children"
          :key="child.id"
          :node="child"
          :path="[...path, i, child.name]"
          :data="data"
          :errors="errors"
          :on-blur="onBlur"
        />
      </template>
    </div>
    <button type="button" class="tiny" @click="addItem">＋ 添加一项</button>
    <div v-if="error" class="field-error">{{ error }}</div>
  </div>

  <!-- 标量字段 -->
  <div v-else class="field-line">
    <label v-if="node.type !== 'boolean'">
      {{ title }}
      <span v-if="node.required" class="req-mark">*</span>
      <span v-if="node.description" class="desc">{{ node.description }}</span>
    </label>

    <!-- boolean -> checkbox -->
    <label v-if="node.type === 'boolean'" style="font-weight: 400">
      <input type="checkbox" :checked="!!value" @change="onCheckbox" @blur="blur" />
      {{ title }}
      <span v-if="node.required" class="req-mark"> *</span>
    </label>

    <!-- enum -> select -->
    <select
      v-else-if="node.enum && node.enum.length"
      :value="value ?? ''"
      :class="{ invalid: !!error }"
      @change="onSelect"
      @blur="blur"
    >
      <option value="">请选择…</option>
      <option v-for="opt in node.enum" :key="String(opt)" :value="opt">{{ opt }}</option>
    </select>

    <!-- number/integer -> number -->
    <input
      v-else-if="node.type === 'number' || node.type === 'integer'"
      type="number"
      :step="node.type === 'integer' ? 1 : 'any'"
      :min="node.minimum"
      :max="node.maximum"
      :value="(value as number | undefined) ?? ''"
      :class="{ invalid: !!error }"
      @input="onInput"
      @blur="blur"
    />

    <!-- string -> text / textarea -->
    <textarea
      v-else-if="node.maxLength !== undefined && node.maxLength > 120"
      :value="(value as string) ?? ''"
      :maxlength="node.maxLength"
      :class="{ invalid: !!error }"
      @input="onInput"
      @blur="blur"
    ></textarea>
    <input
      v-else
      type="text"
      :value="(value as string) ?? ''"
      :minlength="node.minLength"
      :maxlength="node.maxLength"
      :class="{ invalid: !!error }"
      @input="onInput"
      @blur="blur"
    />
    <div v-if="error" class="field-error">⚠ {{ error }}</div>
  </div>
</template>
