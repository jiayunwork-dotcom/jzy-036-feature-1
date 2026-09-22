<script setup lang="ts">
/**
 * 表单预览面板：以当前（最近一次合法的）展开模型渲染可填写表单，
 * 失焦即时单字段校验，提交时全量校验：违例被拦截并定位到字段，通过才放行。
 *
 * 片段引用在渲染前按片段库「当前」定义穿透展开——改一次片段定义，
 * 所有引用处的控件与校验即时变化；悬空/闭环时回退最近合法展开，预览不清空。
 */
import { reactive, ref, computed, watch } from 'vue';
import { session, freshFormData } from '../stores/syncSession';
import { validateField, validateForm, initData, type FieldError, type PathSeg } from '@engine/validate';
import { expandModel } from '@engine/fragments';
import FormField from './FormField.vue';

const formData = reactive<Record<string, unknown>>(freshFormData() as Record<string, unknown>);
const errors = reactive<Record<string, string>>({});
const submitted = ref(false);
const submitResult = ref<{ ok: boolean; text?: string } | null>(null);

/** 展开模型：引用按片段当前定义穿透；非法态回落到最近一次成功展开 */
const expandedModel = computed(() => {
  try {
    return expandModel(session.model, session.library);
  } catch {
    return session.lastExpanded;
  }
});

/** 结构 / 片段库变化后重置数据与错误 */
watch(
  expandedModel,
  (node) => {
    const data = (initData(node, {}) ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(formData)) delete formData[k];
    Object.assign(formData, data);
    for (const k of Object.keys(errors)) delete errors[k];
    submitted.value = false;
    submitResult.value = null;
  },
  { deep: true },
);

function setErrors(list: FieldError[]): void {
  for (const k of Object.keys(errors)) delete errors[k];
  for (const e of list) errors[e.loc] = e.message;
}

function onBlur(path: PathSeg[]): void {
  const list = validateField(session.model, formData, path, session.library);
  // 单字段：先清掉该字段及其子路径旧错误，再写回
  for (const k of Object.keys(errors)) {
    const base = path.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('.').replace(/\.\[/g, '[');
    if (k === base || k.startsWith(`${base}.`) || k.startsWith(`${base}[`)) delete errors[k];
  }
  for (const e of list) errors[e.loc] = e.message;
}

function onSubmit(): void {
  submitted.value = true;
  const list = validateForm(session.model, formData, session.library);
  setErrors(list);
  if (list.length > 0) {
    submitResult.value = {
      ok: false,
      text: `提交被拦截：${list.length} 个字段未通过校验，已定位标红。`,
    };
    const first = document.querySelector('.field-error');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  submitResult.value = { ok: true, text: '校验通过，提交数据如下（JSON）：' };
}

function resetForm(): void {
  const fresh = freshFormData() as Record<string, unknown>;
  for (const k of Object.keys(formData)) delete formData[k];
  Object.assign(formData, fresh);
  for (const k of Object.keys(errors)) delete errors[k];
  submitted.value = false;
  submitResult.value = null;
}
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      ✅ 表单预览
      <span class="hint">真实约束校验（失焦即时、提交全量）</span>
      <span class="spacer" />
      <button class="tiny" @click="resetForm">重置数据</button>
    </div>

    <div class="panel-body">
      <form class="preview-form" @submit.prevent="onSubmit">
        <div v-if="!session.valid" class="warn-banner">
          文本当前非法（可能引用了不存在的片段或形成闭环）：预览展示的是<strong>最近一次合法 Schema</strong> 对应的表单，未被清空。
        </div>

        <div v-if="submitResult?.ok" class="submit-ok">✓ {{ submitResult.text }}</div>
        <div v-else-if="submitResult" class="submit-err">✗ {{ submitResult.text }}</div>

        <FormField
          v-for="child in expandedModel.children"
          :key="child.id"
          :node="child"
          :path="[child.name]"
          :data="formData"
          :errors="errors"
          :on-blur="onBlur"
        />

        <pre v-if="submitResult?.ok" class="schema-dump">{{ JSON.stringify(formData, null, 2) }}</pre>

        <div class="form-actions">
          <button type="submit" class="primary">提交并校验</button>
          <button type="button" @click="resetForm">重置</button>
        </div>
      </form>
    </div>
  </section>
</template>
