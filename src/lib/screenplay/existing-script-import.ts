import Dexie from 'dexie'
import { nanoid } from 'nanoid'
import { db } from '../db/schema'
import type { AdaptationProject, AdaptationSourceUnit, ScreenplayScene, ScreenplayTargetSpecV1, WorkspaceScope } from '../types'
import { hashCanonicalValue } from '../agent/run/hash'
import { assertAdaptationProjectInvariant, assertScreenplayTargetSpecV1 } from '../adaptation/contracts'
import { createWorkspace, workspaceCreationTransactionTablesV1 } from '../workspace/create-workspace'
import { resolveScope, scopeTransactionTables, stampNewRecord } from '../workspace/scope'
import { assertValidScreenplaySceneV1 } from './contracts'
import { parseExistingScreenplayV1, serializeExistingScreenplayV1 } from './existing-script-parser'
import { assertExistingScriptSourceV1 } from './existing-script-source'

/** Parse before any writes; create workspace, source and all scenes in one transaction. */
export async function importExistingScreenplayV1(input: { title: string; sourceName: string; text: string; targetSpec: ScreenplayTargetSpecV1 }) {
  if (!input.title.trim() || input.title.length > 500 || !input.sourceName.trim() || input.sourceName.length > 500) throw new Error('[screenplay-import] 请填写有效作品名称与来源文件名')
  assertScreenplayTargetSpecV1(input.targetSpec)
  const parsed = parseExistingScreenplayV1(input.text)
  const hash = await hashCanonicalValue(input.text)
  const now = Date.now()
  return db.transaction('rw', [...new Set([...workspaceCreationTransactionTablesV1(), ...scopeTransactionTables(db.adaptationProjects, db.adaptationSourceUnits, db.screenplayScenes)])], async () => {
    const created = await createWorkspace({ name: input.title.trim(), description: '已有剧本 · 原文导入与手动修订', genres: [], status: 'drafting', targetWordCount: input.text.length }, { purpose: 'independent-work', kind: 'screenplay' })
    const { scope } = created
    const root: AdaptationProject = stampNewRecord(scope, 'adaptationProjects', {
      projectId: scope.projectId, worldId: scope.worldId, workId: scope.workId, medium: 'screenplay', targetSpec: structuredClone(input.targetSpec),
      lineageMode: 'detached', sourceWorkId: null, sourceOutlineRootId: null, sourceStartChapterId: null, sourceEndChapterId: null,
      sourceSelectionMode: 'existing-script', existingScript: { version: 1, sourceName: input.sourceName }, sourceCoverage: 'full-text',
      status: 'review', brief: null, plan: null, briefSourceManifestVersion: null, planSourceManifestVersion: null, visualBibleSourceManifestVersion: null,
      activeSourceManifestVersion: 1, activeSourceManifestHash: hash, revision: 1, createdAt: now, updatedAt: now,
    }, { owner: 'work' })
    assertAdaptationProjectInvariant(root, created.work, null)
    root.id = await db.adaptationProjects.add(root) as number
    const unit: AdaptationSourceUnit = stampNewRecord(scope, 'adaptationSourceUnits', {
      projectId: scope.projectId, workId: scope.workId, adaptationProjectId: root.id, manifestVersion: 1, sourceKind: 'screenplay',
      sourceOutlineNodeId: null, sourceChapterId: null, sourceUnitKey: `asu_${nanoid(16)}`, order: 0, label: input.sourceName,
      contentHash: hash, sourceContent: input.text, summary: '', wordCount: input.text.length, sourceUpdatedAt: now, createdAt: now,
    }, { owner: 'work' })
    unit.id = await db.adaptationSourceUnits.add(unit) as number
    const scenes = parsed.scenes.map((scene): ScreenplayScene => stampNewRecord(scope, 'screenplayScenes', {
      ...scene, projectId: scope.projectId, workId: scope.workId, adaptationProjectId: root.id!, planSectionKey: '', summary: '',
      // Placeholder only; importing never infers pacing or an audit result.
      estimatedSeconds: 1, sourceUnitIds: [unit.id!], sourceReviewManifestVersion: 1,
      groundingReviewRevision: null, dramaturgyReviewRevision: null, status: 'draft', revision: 1, createdAt: now, updatedAt: now,
    }, { owner: 'work' }))
    scenes.forEach(scene => assertValidScreenplaySceneV1({ scene, adaptation: root, sourceUnitIds: new Set([unit.id!]), bindings: [] }))
    const ids = await db.screenplayScenes.bulkAdd(scenes, { allKeys: true })
    return { ...created, adaptation: root, scenes: scenes.map((scene, i) => ({ ...scene, id: ids[i] as number })) }
  })
}

/** Scope-checked reads and immutable-source hash validation before original-format export. */
export async function exportExistingScreenplayV1(scopeInput: WorkspaceScope, original = false): Promise<string> {
  const scope = await resolveScope({ scope: scopeInput })
  return db.transaction('r', scopeTransactionTables(db.adaptationProjects, db.adaptationSourceUnits, db.screenplayScenes), async () => {
    const root = await db.adaptationProjects.where('workId').equals(scope.workId).first()
    if (!root || root.projectId !== scope.projectId || root.worldId !== scope.worldId) throw new Error('[screenplay-import] 剧本不存在或越界')
    const units = await db.adaptationSourceUnits.where('adaptationProjectId').equals(root.id!).toArray()
    const text = await Dexie.waitFor(assertExistingScriptSourceV1(root, units))
    if (original) return text
    const scenes = await db.screenplayScenes.where('adaptationProjectId').equals(root.id!).sortBy('order')
    return serializeExistingScreenplayV1(text, scenes)
  })
}
