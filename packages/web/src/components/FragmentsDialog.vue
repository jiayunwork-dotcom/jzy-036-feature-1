<script setup lang="ts">
/**
 * 片段库管理对话框：片段是一等资源——
 * 新建（key + 标题 + 定义文本）、编辑定义（保存即新版本，所有引用处随之生效）、
 * 查看引用影响范围、带守卫的删除（仍被引用时列出引用方；可显式摘除引用后归档）。
 * 片段定义文本同样是 Schema 文本，保存由服务端做闭环/悬空/合法性权威校验。
 */
import { computed, ref } from 'vue';
import { fragmentsState, refreshFragments, createFragment, saveFragment, fragmentUsage, removeFragment } from '../stores/fragments';
import { api, type FragmentRecord, type FragmentReference } from '../api';

const emit = defineEmits<{ close: [] }>();

const selectedKey = ref<string | null>(null);
const titleDraft = ref('');
const contentDraft = ref('');
const revision = ref(0);
const saving = ref(false);
const editingNew = ref(false);
const newKey = ref('');
const newTitle = ref('');
const newContent = ref(
  JSON.stringify({ type: 'object', title: '新片段', properties: {} }, null, 2) + '\n',
);
const usage = ref<FragmentReference[] | null>(null);
const versions = ref<Array<{ version: number; revision: number; note: string | null; created_at: string }>>([]);

const selected = computed<FragmentRecord | undefined>(() =>
  fragmentsState.fragments.find((f) => f.key === selectedKey.value),
);

function select(key: string): void {
  const f = fragmentsState.fragments.find((x) => x.key === key);
  if (!f) return;
  selectedKey.value = key;
  titleDraft.value = f.title;
  contentDraft.value = f.content;
  revision.value = f.revision;
  editingNew.value = false;
  usage.value = null;
  void loadVersions();
}

async function loadVersions(): Promise<void> {
  if (!selectedKey.value) {
    versions.value = [];
    return;
  }
  try {
    const r = await api.fragmentVersions(selectedKey.value);
    versions.value = r.versions;
  } catch {
    versions.value = [];
  }
}

function startNew(): void {
  editingNew.value = true;
  selectedKey.value = null;
  usage.value = null;
}

async function submitNew(): Promise<void> {
  const ok = await createFragment(newKey.value.trim(), newTitle.value.trim(), newContent.value);
  if (ok) {
    await refreshFragments();
    select(newKey.value.trim());
  }
}

async function save(): Promise<void> {
  if (!selectedKey.value) return;
  saving.value = true;
  try {
    const ok = await saveFragment(selectedKey.value, {
      title: titleDraft.value.trim(),
      content: contentDraft.value,
      expectedRevision: revision.value,
    });
    if (ok) {
      const f = fragmentsState.fragments.find((x) => x.key === selectedKey.value);
      if (f) {
        revision.value = f.revision;
        contentDraft.value = f.content;
      }
      await loadVersions();
    } else if (fragmentsState.message) {
      // store 已 flash 原因
    }
  } finally {
    saving.value = false;
  }
}

async function showUsage(): Promise<void> {
  if (!selectedKey.value) return;
  usage.value = await fragmentUsage(selectedKey.value);
}

async function onDelete(): Promise<void> {
  if (!selectedKey.value) return;
  const key = selectedKey.value;
  const result = await removeFragment(key, false);
  if (result.ok) {
    selectedKey.value = null;
    return;
  }
  if (result.references) {
    usage.value = result.references;
    const lines = result.references
      .map((r) => `  · ${r.kind === 'document' ? '文档' : '片段'}「${r.name}」${r.path ? ` 位置 ${r.path}` : ''}${r.indirect ? '（间接引用）' : ''}`)
      .join('\n');
    const detach = window.confirm(
      `片段仍被以下 ${result.references.length} 处引用，不能直接删除：\n\n${lines}\n\n` +
        `【确定】= 先摘除以上全部引用再归档删除（引用方会被自动改写并产生新版本）；\n` +
        `【取消】= 放弃删除，片段保持原样。`,
    );
    if (detach) {
      const r2 = await removeFragment(key, true);
      if (r2.ok) {
        selectedKey.value = null;
        await refreshFragments();
      }
    }
  }
}

const canSave = computed(() => titleDraft.value.trim().length > 0);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal fragments-modal">
      <div class="modal-head">
        🧩 可复用结构片段
        <span class="hint">改一次定义，所有引用处同步生效</span>
        <span class="spacer" />
        <button class="tiny" @click="startNew" :disabled="editingNew">＋新建片段</button>
        <button class="tiny" @click="emit('close')">关闭</button>
      </div>
      <div class="modal-body fragments-body">
        <!-- 片段列表 -->
        <div class="frag-list">
          <div
            v-for="f in fragmentsState.fragments"
            :key="f.key"
            class="frag-row"
            :class="{ active: f.key === selectedKey }"
            @click="select(f.key)"
          >
            <strong>🧩 {{ f.title || f.key }}</strong>
            <code class="frag-key">{{ f.key }}</code>
            <span class="hint">v{{ f.revision }}</span>
          </div>
          <div v-if="!fragmentsState.fragments.length" class="hint">片段库为空：此时所有表现与升级前完全一致。</div>
        </div>

        <!-- 新建表单 -->
        <div v-if="editingNew" class="frag-editor">
          <h4>新建片段</h4>
          <div class="detail-grid">
            <label>key（引用标识，创建后不可变）</label>
            <input v-model="newKey" placeholder="如 contact_address" />
            <label>标题</label>
            <input v-model="newTitle" placeholder="如 联系地址" />
            <label>定义（Schema 文本，根类型任意）</label>
            <textarea v-model="newContent" class="frag-textarea" spellcheck="false"></textarea>
          </div>
          <div class="form-actions">
            <button class="primary" @click="submitNew" :disabled="!newKey.trim() || !newTitle.trim()">创建</button>
            <button @click="editingNew = false">取消</button>
          </div>
          <p v-if="fragmentsState.message" class="submit-err">{{ fragmentsState.message }}</p>
        </div>

        <!-- 编辑已有片段 -->
        <div v-else-if="selected" class="frag-editor">
          <h4>
            🧩 {{ selected.title }}
            <code class="frag-key">{{ selected.key }}</code>
            <span class="hint">当前 revision {{ revision }}</span>
          </h4>
          <div class="detail-grid">
            <label>标题</label>
            <input v-model="titleDraft" />
            <label>定义（片段内容改动即时影响所有引用处的控件/预览/校验）</label>
            <textarea v-model="contentDraft" class="frag-textarea" spellcheck="false"></textarea>
          </div>
          <div class="form-actions">
            <button class="primary" :disabled="!canSave || saving" @click="save">保存定义（产生新版本）</button>
            <button @click="showUsage">查看引用影响范围</button>
            <button class="danger" @click="onDelete">删除片段…</button>
          </div>
          <p v-if="fragmentsState.message" :class="fragmentsState.message.includes('失败') ? 'submit-err' : 'submit-ok'">
            {{ fragmentsState.message }}
          </p>

          <!-- 引用影响范围 -->
          <div v-if="usage" class="usage-box">
            <strong>引用方（{{ usage.length }}）</strong>
            <div v-if="!usage.length" class="hint">没有任何文档或片段引用它，可以安全删除。</div>
            <ul v-else>
              <li v-for="(r, i) in usage" :key="i">
                {{ r.kind === 'document' ? '📄 文档' : '🧩 片段' }}
                <strong>「{{ r.name }}」</strong>
                <span v-if="r.path" class="hint">位置：{{ r.path }}</span>
                <span v-if="r.indirect" class="hint">（经由其他片段间接引用）</span>
              </li>
            </ul>
          </div>

          <!-- 版本历史 -->
          <div v-if="versions.length" class="usage-box">
            <strong>版本历史</strong>
            <ul>
              <li v-for="v in versions" :key="v.version">
                v{{ v.version }} <span class="hint">revision {{ v.revision }} · {{ v.note }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div v-else class="hint" style="padding: 20px">
          从左侧选择片段编辑，或新建一个可复用结构片段。
        </div>
      </div>
    </div>
  </div>
</template>
