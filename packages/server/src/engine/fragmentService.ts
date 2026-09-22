/**
 * 片段服务：在持久化层之上组合「片段库」、引用关系扫描、闭环/悬空校验与级联处理。
 *
 * - 片段内容在库中以 Schema 文本存储；服务层负责解析为结构模型供引擎使用；
 * - 保存片段时定向做闭环/悬空检测，保证片段图永远无环、无悬空；
 * - 删除片段前扫描全部文档与其他片段的引用：默认拒绝并列引用方；
 *   显式 cascade 时在单事务内把引用处「一跳内联」为快照再删除；
 * - 文档保存边界用 validateDocumentText 做权威校验（引用必须可解析、可展开）。
 */
import { ReferenceEntry as DbReferenceEntry, Repository } from '../db';
import { parseSchemaText } from './parser';
import { modelToSchemaText, modelToSchemaTextAny } from './serialize';
import {
  FragmentLibrary,
  GraphIssue,
  RefOccurrence,
  checkSaveFragment,
  collectRefs,
  expandModel,
  inlineRefsInTree,
  isValidFragmentName,
} from './fragments';
import { FieldNode } from './types';

/** 从仓储构建片段库；某片段内容损坏时跳过并记录（正常保存边界不会产生损坏内容） */
export function buildLibrary(repo: Repository): { library: FragmentLibrary; errors: string[] } {
  const library: FragmentLibrary = {};
  const errors: string[] = [];
  for (const f of repo.listFragments()) {
    const rec = repo.getFragment(f.name)!;
    const parsed = parseSchemaText(rec.content, { allowNonObjectRoot: true });
    if (!parsed.ok || !parsed.model) {
      errors.push(`片段「${f.name}」当前定义不合法：${parsed.error ?? '解析失败'}`);
      continue;
    }
    parsed.model.name = '';
    library[f.name] = parsed.model;
  }
  return { library, errors };
}

export interface ValidationOutcome {
  ok: boolean;
  error?: string;
  issues?: GraphIssue[];
}

/** 校验待保存的片段定义文本（解析 + 从该片段出发的闭环/悬空检测） */
export function validateFragmentText(
  name: string,
  content: string,
  library: FragmentLibrary,
): ValidationOutcome {
  if (!isValidFragmentName(name)) {
    return {
      ok: false,
      error: `非法片段名「${name}」：需字母/下划线开头，仅含字母数字下划线或中划线`,
    };
  }
  // 只做结构解析（不带库）：引用图的闭环/悬空统一由 checkSaveFragment 判定，
  // 这样自引用（新片段引用自己）会被正确识别为「闭环」而非「悬空」。
  const parsed = parseSchemaText(content, { allowNonObjectRoot: true });
  if (!parsed.ok || !parsed.model) {
    return { ok: false, error: `片段定义不合法：${parsed.error ?? '解析失败'}` };
  }
  // 定向检测：从该片段可达的环 / 该片段自身的悬空引用
  const issues = checkSaveFragment(name, parsed.model, library);
  if (issues.length > 0) return { ok: false, error: issues.map((i) => i.message).join('；'), issues };
  return { ok: true };
}

/** 文档保存/导入边界的权威校验：必须可解析、引用全部可展开、无环无悬空 */
export function validateDocumentText(content: string, library: FragmentLibrary): ValidationOutcome {
  const parsed = parseSchemaText(content, { library });
  if (!parsed.ok || !parsed.model) return { ok: false, error: parsed.error ?? 'Schema 不合法' };
  try {
    expandModel(parsed.model, library);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

/** 扫描某个片段被哪些文档、哪些片段、哪些位置引用（删除/修改前的影响范围提示） */
export function findReferences(repo: Repository, target: string): DbReferenceEntry[] {
  const entries: DbReferenceEntry[] = [];

  for (const doc of repo.allDocs()) {
    const parsed = parseSchemaText(doc.content);
    if (!parsed.ok || !parsed.model) continue;
    for (const occ of collectRefs(parsed.model)) {
      if (occ.target === target) {
        entries.push({ kind: 'document', documentId: doc.id, documentName: doc.name, path: occ.path });
      }
    }
  }
  for (const f of repo.listFragments()) {
    const rec = repo.getFragment(f.name)!;
    const parsed = parseSchemaText(rec.content, { allowNonObjectRoot: true });
    if (!parsed.ok || !parsed.model) continue;
    for (const occ of collectRefs(parsed.model)) {
      if (occ.target === target) {
        entries.push({ kind: 'fragment', fragmentName: f.name, path: occ.path });
      }
    }
  }
  return entries;
}

export type { DbReferenceEntry as ReferenceEntry, RefOccurrence };

export interface CascadeResult {
  inlinedDocuments: Array<{ id: number; name: string }>;
  inlinedFragments: string[];
}

/**
 * 级联删除：在单事务内把所有引用处一跳内联为目标片段定义的快照
 * （快照内对其他片段的引用原样保留），然后删除目标片段及其版本。
 * 任一步骤失败则整个事务回滚，不产生脏数据。
 */
export function cascadeDeleteFragment(repo: Repository, name: string): CascadeResult {
  const target = repo.getFragment(name);
  if (!target) throw new Error(`片段「${name}」不存在`);
  const targetParsed = parseSchemaText(target.content, { allowNonObjectRoot: true });
  if (!targetParsed.ok || !targetParsed.model) {
    throw new Error(`片段「${name}」当前定义不合法，无法级联内联：${targetParsed.error ?? ''}`);
  }

  return repo.withTransaction(() => {
    // 用删除前的完整库构造内联环境
    const { library } = buildLibrary(repo);

    const docRewrites: Array<{ id: number; content: string; note: string }> = [];
    const inlinedDocuments: Array<{ id: number; name: string }> = [];
    for (const doc of repo.allDocs()) {
      const parsed = parseSchemaText(doc.content);
      if (!parsed.ok || !parsed.model) continue;
      const n = inlineRefsInTree(parsed.model, name, library);
      if (n > 0) {
        docRewrites.push({
          id: doc.id,
          content: modelToSchemaText(parsed.model),
          note: `级联删除片段「${name}」：${n} 处引用内联为结构快照`,
        });
        inlinedDocuments.push({ id: doc.id, name: doc.name });
      }
    }

    const fragRewrites: Array<{ name: string; content: string; note: string }> = [];
    const inlinedFragments: string[] = [];
    for (const f of repo.listFragments()) {
      if (f.name === name) continue;
      const rec = repo.getFragment(f.name)!;
      const parsed = parseSchemaText(rec.content, { allowNonObjectRoot: true });
      if (!parsed.ok || !parsed.model) continue;
      const n = inlineRefsInTree(parsed.model, name, library);
      if (n > 0) {
        fragRewrites.push({
          name: f.name,
          content: serializeFragmentModel(parsed.model),
          note: `级联删除片段「${name}」：${n} 处引用内联为结构快照`,
        });
        inlinedFragments.push(f.name);
      }
    }

    if (docRewrites.length > 0) repo.rewriteDocs(docRewrites);
    if (fragRewrites.length > 0) repo.rewriteFragments(fragRewrites);
    repo.deleteFragmentRow(name);
    return { inlinedDocuments, inlinedFragments };
  });
}

/** 片段模型序列化（根可为任意类型） */
export function serializeFragmentModel(root: FieldNode): string {
  return root.type === 'object' ? modelToSchemaText(root) : modelToSchemaTextAny(root);
}
