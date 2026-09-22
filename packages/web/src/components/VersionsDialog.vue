<script setup lang="ts">
/** 版本轨迹：查看历史版本内容，并可回滚（回滚会产生新版本） */
import { ref } from 'vue';
import { docsState, fetchVersion, rollbackTo } from '../stores/docs';
import { loadText } from '../stores/syncSession';

const emit = defineEmits<{ close: [] }>();

const viewing = ref<{ version: number; content: string; note: string | null } | null>(null);
const busy = ref(false);

async function view(version: number): Promise<void> {
  const v = await fetchVersion(version);
  viewing.value = { version: v.version, content: v.content, note: v.note };
}

async function rollback(version: number): Promise<void> {
  if (!window.confirm(`确认把当前文档回滚到 v${version}？将以该内容生成一个新版本。`)) return;
  busy.value = true;
  try {
    const ok = await rollbackTo(version, (t) => loadText(t));
    if (ok) {
      viewing.value = null;
      emit('close');
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        🕘 历史版本 — {{ docsState.currentName }}
        <span class="spacer" />
        <button class="tiny" @click="emit('close')">关闭</button>
      </div>
      <div class="modal-body">
        <p class="hint">每次保存都会留存一份内容快照；回滚会把所选版本内容写成新版本，轨迹连续。</p>
        <div v-for="v in docsState.versions" :key="v.version" class="version-row">
          <strong>v{{ v.version }}</strong>
          <span class="hint">revision {{ v.revision }} · {{ v.created_at.replace('T', ' ') }}</span>
          <span>{{ v.note }}</span>
          <span class="spacer" style="flex: 1" />
          <button class="tiny" @click="view(v.version)">查看</button>
          <button
            class="tiny primary"
            :disabled="busy || v.revision === docsState.revision"
            @click="rollback(v.version)"
          >
            回滚到此版本
          </button>
        </div>

        <template v-if="viewing">
          <h4>v{{ viewing.version }} 内容预览 <span class="hint">{{ viewing.note }}</span></h4>
          <pre class="schema-dump">{{ viewing.content }}</pre>
          <button class="primary" :disabled="busy" @click="rollback(viewing.version)">
            回滚到 v{{ viewing.version }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
