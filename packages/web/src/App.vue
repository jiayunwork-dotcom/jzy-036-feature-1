<script setup lang="ts">
import { onMounted, ref } from 'vue';
import StructureEditor from './components/StructureEditor.vue';
import TextEditor from './components/TextEditor.vue';
import FormPreview from './components/FormPreview.vue';
import VersionsDialog from './components/VersionsDialog.vue';
import { session, loadText, onTextInput } from './stores/syncSession';
import {
  docsState,
  refreshList,
  loadDocument,
  createDocument,
  saveCurrent,
  renameCurrent,
  removeDocument,
  newDocumentState,
  notify,
} from './stores/docs';

const showVersions = ref(false);
const nameEditing = ref(false);
const nameDraft = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  try {
    await refreshList();
    // 默认载入预置示范文档，保证打开即「三侧一致、可交互」
    const demo = docsState.documents[0];
    if (demo) await loadDocument(demo.id, (t) => loadText(t));
  } catch (e) {
    notify(`无法连接服务端：${(e as Error).message}`);
  }
});

function onSelectDoc(e: Event): void {
  const id = Number((e.target as HTMLSelectElement).value);
  if (!id) return;
  void loadDocument(id, (t) => loadText(t));
}

async function onNew(): Promise<void> {
  const name = window.prompt('新文档名称', '未命名 Schema');
  if (!name) return;
  const blank = JSON.stringify(
    { type: 'object', title: name, properties: {} },
    null,
    2,
  ) + '\n';
  await createDocument(name, blank);
  loadText(blank);
}

async function onSave(): Promise<void> {
  if (!session.valid) {
    notify('当前 Schema 文本非法，无法保存。请修正后再保存。');
    return;
  }
  await saveCurrent(session.text);
}

async function onRename(): Promise<void> {
  nameDraft.value = docsState.currentName;
  nameEditing.value = true;
}

async function submitRename(): Promise<void> {
  if (nameDraft.value.trim()) await renameCurrent(nameDraft.value.trim());
  nameEditing.value = false;
}

async function onDelete(): Promise<void> {
  if (!docsState.currentId) return;
  if (window.confirm(`确认删除「${docsState.currentName}」及其全部历史版本？`)) {
    await removeDocument(docsState.currentId);
    newDocumentState();
    loadText(JSON.stringify({ type: 'object', title: '未命名表单', properties: {} }, null, 2) + '\n');
  }
}

function onExport(): void {
  if (!session.valid) {
    notify('当前文本非法，不能导出。');
    return;
  }
  const blob = new Blob([session.text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${docsState.currentName || 'schema'}.schema.json`;
  a.click();
  URL.revokeObjectURL(url);
  notify('已导出 Schema 文件');
}

function onImportClick(): void {
  fileInput.value?.click();
}

function onImportFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? '');
    const ok = onTextInput(text);
    if (ok) {
      // 导入的是外部 Schema：脱离已选文档，等待用户另存为新文档
      newDocumentState();
      notify('导入成功：已反向铺开为结构与文本，可「新建并保存」持久化。');
    } else {
      notify('导入失败：文件内容不是合法的受支持 Schema，结构区保持在最近合法态。');
    }
  };
  reader.readAsText(file);
}
</script>

<template>
  <div class="app-shell">
    <div class="docbar">
      <span class="title">JSON Schema 表单生成器</span>
      <select :value="docsState.currentId ?? ''" @change="onSelectDoc" title="载入文档">
        <option value="" disabled>选择文档…</option>
        <option v-for="d in docsState.documents" :key="d.id" :value="d.id">
          {{ d.name }}（v{{ d.revision }}）
        </option>
      </select>
      <button class="tiny" @click="onNew">新建</button>
      <button class="tiny" @click="onSave">保存</button>
      <template v-if="nameEditing">
        <input v-model="nameDraft" style="width: 150px" @keyup.enter="submitRename" />
        <button class="tiny primary" @click="submitRename">确定</button>
      </template>
      <button v-else class="tiny" :disabled="!docsState.currentId" @click="onRename">重命名</button>
      <button class="tiny danger" :disabled="!docsState.currentId" @click="onDelete">删除</button>
      <button class="tiny" :disabled="!docsState.currentId" @click="showVersions = true">
        历史版本（{{ docsState.versions.length }}）
      </button>
      <span class="spacer" />
      <button class="tiny" @click="onImportClick">导入 Schema</button>
      <button class="tiny" @click="onExport">导出 Schema</button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onImportFile" />
      <span v-if="docsState.currentId" class="rev-badge">
        {{ docsState.currentName }} · revision {{ docsState.revision }}
      </span>
      <span v-else class="rev-badge">未持久化（导入/新建后保存）</span>
    </div>

    <div class="workspace">
      <StructureEditor />
      <TextEditor />
      <FormPreview />
    </div>

    <VersionsDialog v-if="showVersions" @close="showVersions = false" />
    <div v-if="docsState.message" class="flash">{{ docsState.message }}</div>
  </div>
</template>
