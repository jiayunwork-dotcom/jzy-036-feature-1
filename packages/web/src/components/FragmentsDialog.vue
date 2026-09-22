<script setup lang="ts">
/**
 * 片段库管理：一等资源的独立管理界面。
 *  - 新建 / 编辑片段定义（直接编辑 Schema 文本，保存时服务端拦截闭环/悬空）；
 *  - 删除前查看影响范围（被哪些文档/片段、哪些位置引用），默认拒绝；
 *    可显式选择「级联：把引用处内联为快照后删除」；
 *  - 版本历史查看。
 */
import { computed, ref } from 'vue';
import { fragmentsState, createFragment, saveFragment, removeFragment, fetchReferences } from '../stores/fragments';
import { api, type FragmentReference, type VersionRecord } from '../api';

const emit = defineEmits<{ close: [] }>();

const editingName = ref<string | null>(null);
const editorText = ref('');
const editorTitle = ref('');
const editorRevision = ref(0);
const creating = ref(false);
const createName = ref('');
const createTitle = ref('');
const createText = ref('');
const references = ref<FragmentReference[] | null>(null);
const versions = ref<VersionRecord[] | null>(null);
const viewingVersion = ref<VersionRecord | null>(null);

const editingSummary = computed(() =>
  fragmentsState.fragments.find((f) => f.name === editingName.value),
);

async function startCreate(): Promise<void> {
  creating.value = true;
  editingName.value = null;
  references.value = null;
  versions.value = null;
  createName.value = '';
  createTitle.value = '';
  createText.value = JSON.stringify(
    { type: 'object', title: '', properties: { field1: { type: 'string' } } },
    null,
    2,
  ) + '\n';
}

async function openFragment(name: string): Promise<void> {
  creating.value = false;
  editingName.value = name;
  const { fragment } = await api.getFragment(name);
  editorText.value = fragment.content;
  editorTitle.value = fragment.title ?? '';
  editorRevision.value = fragment.revision;
  references.value = await fetchReferences(name);
  const { versions: vs } = await api.fragmentVersions(name);
  versions.value = vs;
  viewingVersion.value = null;
}

async function submitCreate(): Promise<void> {
  if (!createName.value.trim()) return;
  const ok = await createFragment(createName.value.trim(), createText.value, createTitle.value || undefined);
  if (ok) {
    await openFragment(createName.value.trim());
    creating.value = false;
  }
}

async function submitSave(): Promise<void> {
  if (!editingName.value) return;
  const saved = await saveFragment(
    editingName.value,
    editorText.value,
    editorRevision.value,
    editorTitle.value || undefined,
  );
  if (saved) {
    editorRevision.value = saved.revision;
    references.value = await fetchReferences(editingName.value);
    const { versions: vs } = await api.fragmentVersions(editingName.value);
    versions.value = vs;
  }
}

async function doDelete(cascade: boolean): Promise<void> {
  if (!editingName.value) return;
  const name = editingName.value;
  const result = await removeFragment(name, cascade);
  if (result.ok) {
    editingName.value = null;
    references.value = null;
    versions.value = null;
  } else {
    references.value = result.references;
  }
}

async function viewVersion(v: number): Promise<void> {
  if (!editingName.value) return;
  const { version } = await api.getFragmentVersion(editingName.value, v);
  viewingVersion.value = version;
}

function refLabel(r: FragmentReference): string {
  if (r.kind === 'document') return `文档「${r.documentName}」(#${r.documentId}) · 位置 ${r.path || '根'}`;
  return `片段「${r.fragmentName}」 · 位置 ${r.path || '根'}`;
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="max-width: 820px">
      <div class="modal-head">
        🧩 可复用结构片段
        <span class="hint">独立命名 · 独立版本 · 引用跟随定义更新</span>
        <span class="spacer" />
        <button class="tiny" @click="startCreate">＋ 新建片段</button>
        <button class="tiny" @click="emit('close')">关闭</button>
      </div>
      <div class="modal-body">
        <div class="frag-layout">
          <!-- 左：片段列表 -->
          <div class="frag-list">
            <div
              v-for="f in fragmentsState.fragments"
              :key="f.name"
              :class="['frag-item', { active: editingName === f.name }]"
              @click="openFragment(f.name)"
            >
              <div><strong>{{ f.name }}</strong></div>
              <div class="hint">{{ f.title || '（无标题）' }} · v{{ f.revision }}</div>
            </div>
            <div v-if="fragmentsState.fragments.length === 0" class="hint">
              片段库为空：此时所有文档行为与升级前完全一致。
            </div>
          </div>

          <!-- 右：编辑/详情 -->
          <div class="frag-detail">
            <template v-if="creating">
              <h4>新建片段</h4>
              <label>片段名（身份标识，创建后不可改）</label>
              <input v-model="createName" placeholder="如 contactAddress" />
              <label>标题（可选）</label>
              <input v-model="createTitle" placeholder="如 联系地址" />
              <label>定义（Schema 文本，根可为任意类型）</label>
              <textarea v-model="createText" class="frag-editor" spellcheck="false"></textarea>
              <div class="form-actions">
                <button class="primary" @click="submitCreate">创建</button>
                <button @click="creating = false">取消</button>
              </div>
            </template>

            <template v-else-if="editingName">
              <h4>
                编辑片段「{{ editingName }}」
                <span class="hint">revision {{ editorRevision }}</span>
              </h4>
              <label>标题（可选）</label>
              <input v-model="editorTitle" />
              <label>定义（保存时检测闭环 / 悬空引用）</label>
              <textarea v-model="editorText" class="frag-editor" spellcheck="false"></textarea>
              <div class="form-actions">
                <button class="primary" @click="submitSave">保存修改（产生新版本）</button>
                <button class="danger" @click="doDelete(false)">删除</button>
              </div>

              <h4>被引用情况（删除/修改前影响范围）</h4>
              <div v-if="references && references.length === 0" class="hint">
                当前没有任何文档或片段引用它，可以安全删除。
              </div>
              <ul v-else-if="references" class="ref-list">
                <li v-for="(r, i) in references" :key="i">{{ refLabel(r) }}</li>
              </ul>
              <div v-if="references && references.length > 0" class="cascade-box">
                <strong>该片段仍被引用。</strong>
                直接删除会被拒绝；若确认要删除，可级联处理：
                把上述 {{ references.length }} 处引用在原地内联为当前结构的快照（快照内对其他片段的引用保持不变），然后删除片段。
                <div class="form-actions">
                  <button class="danger" @click="doDelete(true)">级联内联并删除</button>
                </div>
              </div>

              <h4>版本历史</h4>
              <div v-for="v in versions" :key="v.version" class="version-row">
                <strong>v{{ v.version }}</strong>
                <span class="hint">revision {{ v.revision }}</span>
                <span>{{ v.note }}</span>
                <span class="spacer" style="flex:1" />
                <button class="tiny" @click="viewVersion(v.version)">查看</button>
              </div>
              <template v-if="viewingVersion">
                <pre class="schema-dump">{{ viewingVersion.content }}</pre>
              </template>
            </template>

            <div v-else class="hint">
              从左侧选择一个片段，或新建一个。片段中可以用
              <code>{ "$ref": "fragment:另一个片段名" }</code>
              引用其他片段（不允许闭环）。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
