import { describe, expect, it } from 'vitest'
import { parseExistingScreenplayV1, serializeExistingScreenplayV1 } from '../../src/lib/screenplay/existing-script-parser'

const script = '\uFEFF标题\r\nep01-s00\r\n01—00内·旧车站·夜\r\n环境\r\n雨打在玻璃上。\r\n林岚〔轻声〕：\r\n我还是来了。\r\n声音\r\n远处汽笛。\r\nAI演绎注\r\n保持克制。\r\n'

describe('SCREEN-6 · existing screenplay', () => {
  it('保留场次身份、正文、来源标签和 CRLF/BOM，重复解析稳定', () => {
    const parsed = parseExistingScreenplayV1(script)
    expect(parsed.scenes[0].stableKey).toBe('ep01-s00')
    expect(parsed.scenes[0].blocks.map(b => b.id)).toEqual(['ep01-s00-b001', 'ep01-s00-b002', 'ep01-s00-b003', 'ep01-s00-b004', 'ep01-s00-b005', 'ep01-s00-b006'])
    expect(parsed.scenes[0].blocks.at(-1)?.source?.audienceVisible).toBe(false)
    expect(parsed.scenes[0].blocks.at(-2)).toMatchObject({ text: '远处汽笛。', source: { kind: 'sound', label: '声音' } })
    expect(serializeExistingScreenplayV1(script, parsed.scenes)).toBe(script)
    expect(parseExistingScreenplayV1(script)).toEqual(parsed)
  })
})

import { afterEach, beforeEach, vi } from 'vitest'
import { db } from '../../src/lib/db/schema'
import { importExistingScreenplayV1, exportExistingScreenplayV1 } from '../../src/lib/screenplay/existing-script-import'
import { listScreenplayScenes, updateScreenplayScene, setScreenplaySceneLocked, duplicateScreenplayScene, deleteScreenplayScene, reorderScreenplayScenes } from '../../src/lib/screenplay/service'
import { inspectAdaptationFreshness, readAdaptationSourceContent, saveAdaptationPlanDraft } from '../../src/lib/adaptation/source-manifest'
import { exportProjectJSON, importProjectJSON } from '../../src/lib/export/json-export'
import { deleteWork, deleteWorkspace } from '../../src/lib/workspace/lifecycle'
import { readScreenplayAuthorDraft, saveScreenplayAuthorDraft } from '../../src/lib/screenplay/author-drafts'
import { generateScreenplayProfessionalCandidateV1 } from '../../src/lib/screenplay/durable-production'
import { startScreenplayProductionV1 } from '../../src/lib/screenplay/production'
import { validateScreenplayBlocksV1 } from '../../src/lib/screenplay/contracts'
import { renderScreenplayFountainV1 } from '../../src/lib/screenplay/renderers'
import type { ScreenplayTargetSpecV1 } from '../../src/lib/types'

const spec: ScreenplayTargetSpecV1 = {
  format: 'film', language: 'zh-CN', episodeCount: null, targetMinutesPerEpisode: 100,
  rating: 'PG-13', dialogueDensity: 'balanced', productionScale: 'standard', preserveVoiceOver: false,
  titlePage: { creditLine: '原创剧本', authorDisplayName: '作者', contactText: '', copyrightNotice: '', draftLabel: '原稿' }, exportDefaults: ['fountain'],
}
const create = (text = script) => importExistingScreenplayV1({ title: '雨夜', sourceName: '雨夜.txt', text, targetSpec: spec })

describe('SCREEN-6 · source validation and lossless edits', () => {
  it('保留插入场次且编号不相撞；正文编辑不改变稳定 ID', () => {
    const source = 'ep01-s05\n01—05内·车站·夜\n动作\n雨落下。\nep01-s05a\n01—05A内·车站·夜\n动作\n灯亮了。\n'
    const parsed = parseExistingScreenplayV1(source)
    expect(parsed.scenes.map(scene => scene.stableKey)).toEqual(['ep01-s05', 'ep01-s05a'])
    expect(new Set(parsed.scenes.map(scene => scene.sceneNumber)).size).toBe(2)
    const changed = structuredClone(parsed.scenes)
    changed[0].blocks[0] = { ...changed[0].blocks[0], type: 'action', text: '雨停了。' }
    expect(serializeExistingScreenplayV1(source, changed)).toBe(source.replace('雨落下。', '雨停了。'))
    expect(changed[0].blocks[0].id).toBe(parsed.scenes[0].blocks[0].id)
  })
  it('片尾、彩蛋独立保留，制作时间与视点不会混入观众内容', () => {
    const source = 'ep01-s00\n01—00内·车站·夜\n生活短切 · 约10秒 · 身体控制／视点 林岚\n动作\n雨。\nep01-ed\n01-ED片尾 ED · 公园\nv6.9.0片尾参考（待校时） · 片尾曲\n动作\n空椅。\nep01-post\n01-POST彩蛋 · 公园\n完整ED与三秒黑屏之后 · 数日后 · 夜\n动作\n灯。\n'
    const parsed = parseExistingScreenplayV1(source)
    expect(parsed.scenes.map(scene => scene.stableKey)).toEqual(['ep01-s00', 'ep01-ed', 'ep01-post'])
    expect(parsed.scenes.map(scene => scene.blocks[0].source?.audienceVisible)).toEqual([false, false, false])
    expect(serializeExistingScreenplayV1(source, parsed.scenes)).toBe(source)
  })
  it('文本框的 LF 修订按原稿 CRLF 导出；带冒号的演绎注不会当成对白 cue', () => {
    const source = 'ep01-s00\r\n01—00内·车站·夜\r\n动作\r\n雨。\r\n灯。\r\nAI演绎注：\r\n克制。\r\n'
    const scenes = parseExistingScreenplayV1(source).scenes
    expect(scenes[0].blocks[1].source?.audienceVisible).toBe(false)
    scenes[0].blocks[0] = { ...scenes[0].blocks[0], type: 'action', text: '雨停。\n灯灭。' }
    expect(serializeExistingScreenplayV1(source, scenes)).toBe(source.replace('雨。\r\n灯。', '雨停。\r\n灯灭。'))
  })
  it('万象与主观标题保留地点前缀，时间缺失明确注明', () => {
    const source = 'ep01-s00\n01—00万象·旧机房·傍晚\n动作\n雨。\nep01-s01\n01—01内·保护区\n动作\n灯。'
    const scenes = parseExistingScreenplayV1(source).scenes
    expect(scenes[0].location).toBe('万象·旧机房')
    expect(scenes[1]).toMatchObject({ location: '保护区', timeOfDay: '未注明' })
    expect(serializeExistingScreenplayV1(source, scenes)).toBe(source)
  })
  it.each([
    script + script,
    'ep01-s00\n02—00内·车站·夜\n动作\n雨。',
    'ep01-s00\n01—00内\n动作\n雨。',
    'ep01-s00\n01—00内·车站·夜\n林岚：',
    'ep01-s00\n01—00内·车站·夜\n对白\n雨。',
    'ep01-sx\n动作\n雨。',
  ])('拒绝重复身份、不完整标题或孤立对白', invalid => expect(() => parseExistingScreenplayV1(invalid)).toThrow())
  it('拒绝来源伪造、标签注入与非法 metadata，不因缺失文本崩溃', () => {
    const parsed = parseExistingScreenplayV1(script)
    const wrong = structuredClone(parsed.scenes)
    wrong[0].blocks[0].source!.audienceVisible = false
    expect(validateScreenplayBlocksV1(wrong[0].blocks).valid).toBe(false)
    expect(() => serializeExistingScreenplayV1(script, wrong)).toThrow()
    const injected = structuredClone(parsed.scenes)
    injected[0].blocks[0] = { ...injected[0].blocks[0], type: 'action', text: '雨。\n声音\n汽笛。' }
    expect(() => serializeExistingScreenplayV1(script, injected)).toThrow('结构歧义')
    expect(validateScreenplayBlocksV1([{ id: 'x', type: 'action' }] as any).valid).toBe(false)
  })
})

describe('SCREEN-6 · existing script lifecycle', () => {
  beforeEach(async () => { await db.delete(); await db.open() })
  afterEach(() => { vi.restoreAllMocks(); db.close() })
  it('原子导入真实 screenplay Work，无虚构 novel/chapter/Brief/Plan，声音保留、制作说明默认隐藏', async () => {
    const created = await create()
    expect(created.work.kind).toBe('screenplay')
    expect(await db.works.count()).toBe(1)
    expect(await db.chapters.count()).toBe(0)
    expect(await db.outlineNodes.count()).toBe(0)
    expect(created.adaptation).toMatchObject({ sourceSelectionMode: 'existing-script', sourceWorkId: null, brief: null, plan: null })
    expect(await exportExistingScreenplayV1(created.scope)).toBe(script)
    expect((await inspectAdaptationFreshness(created.adaptation.id!)).status).toBe('unchanged')
    const unit = await db.adaptationSourceUnits.toCollection().first()
    const read = await readAdaptationSourceContent({ targetScope: created.scope, adaptationProjectId: created.adaptation.id!, manifestVersion: 1, sourceUnitKeys: [unit!.sourceUnitKey] })
    expect(read.units[0].content).toBe(script)
    await expect(readAdaptationSourceContent({ targetScope: created.scope, adaptationProjectId: created.adaptation.id!, manifestVersion: 2, sourceUnitKeys: [unit!.sourceUnitKey] })).rejects.toThrow('版本')
    const rendered = renderScreenplayFountainV1({ title: '雨夜', targetSpec: spec, scenes: created.scenes })
    expect(rendered).toContain('远处汽笛。')
    expect(rendered).not.toContain('保持克制。')
  })
  it('CAS 修订、独立解锁、来源不可修改；编辑后原稿和修订稿各自保留', async () => {
    const created = await create()
    const scene = created.scenes[0]
    const blocks = structuredClone(scene.blocks)
    blocks[0] = { ...blocks[0], type: 'action', text: '雨停了。' }
    const saved = await updateScreenplayScene({ scope: created.scope, sceneId: scene.id!, expectedRevision: 1, patch: { blocks } })
    await expect(updateScreenplayScene({ scope: created.scope, sceneId: scene.id!, expectedRevision: 1, patch: { blocks } })).rejects.toThrow('已变化')
    expect(await exportExistingScreenplayV1(created.scope)).toBe(script.replace('雨打在玻璃上。', '雨停了。'))
    expect(await exportExistingScreenplayV1(created.scope, true)).toBe(script)
    const locked = await setScreenplaySceneLocked({ scope: created.scope, sceneId: saved.id!, expectedRevision: saved.revision, locked: true })
    await expect(updateScreenplayScene({ scope: created.scope, sceneId: locked.id!, expectedRevision: locked.revision, patch: { status: 'draft', blocks } })).rejects.toThrow('先解锁')
    const unlocked = await setScreenplaySceneLocked({ scope: created.scope, sceneId: locked.id!, expectedRevision: locked.revision, locked: false })
    const forged = structuredClone(blocks); forged[0].source!.start++
    await expect(updateScreenplayScene({ scope: created.scope, sceneId: unlocked.id!, expectedRevision: unlocked.revision, patch: { blocks: forged } })).rejects.toThrow('来源已变化')
    await expect(duplicateScreenplayScene({ scope: created.scope, sceneId: unlocked.id! })).rejects.toThrow('结构')
    await expect(deleteScreenplayScene({ scope: created.scope, sceneId: unlocked.id! })).rejects.toThrow('结构')
    await expect(reorderScreenplayScenes({ scope: created.scope, orderedSceneIds: [unlocked.id!] })).rejects.toThrow('结构')
    await expect(saveAdaptationPlanDraft({ adaptationProjectId: created.adaptation.id!, expectedRevision: 1, plan: { version: 1, premise: '雨夜', sections: [{ stableKey: 'act-1', title: '起', summary: '雨', order: 0, episodeNumber: 1, sourceUnitKeys: [] }], globalAssumptions: [] } })).rejects.toThrow('不使用小说')
  })
  it('备份恢复重映射 owner/source ID，保留冻结原文与段落元数据，删除 Work 级联清理', async () => {
    const created = await create()
    const scene = created.scenes[0]
    const blocks = structuredClone(scene.blocks); blocks[0] = { ...blocks[0], type: 'action', text: '雨停了。' }
    await updateScreenplayScene({ scope: created.scope, sceneId: scene.id!, expectedRevision: 1, patch: { blocks } })
    const draftKey = `existing-scene:${scene.stableKey}:r2`
    await saveScreenplayAuthorDraft(created.scope, draftKey, JSON.stringify(blocks))
    const backup = await exportProjectJSON(created.scope.projectId)
    const projectId = await importProjectJSON(structuredClone(backup))
    const work = await db.works.where('projectId').equals(projectId).first()
    const scope = { projectId, worldId: work!.worldId, workId: work!.id! }
    expect(await exportExistingScreenplayV1(scope, true)).toBe(script)
    expect(await exportExistingScreenplayV1(scope)).toBe(script.replace('雨打在玻璃上。', '雨停了。'))
    expect((await listScreenplayScenes(scope))[0].blocks).toEqual(blocks)
    expect(await readScreenplayAuthorDraft(scope, draftKey)).toBe(JSON.stringify(blocks))
    const restoredScene = (await listScreenplayScenes(scope))[0]
    expect(restoredScene.sourceUnitIds).not.toEqual(scene.sourceUnitIds)
    await deleteWork(scope.workId)
    expect(await db.screenplayScenes.where('projectId').equals(projectId).count()).toBe(0)
    expect(await db.adaptationSourceUnits.where('projectId').equals(projectId).count()).toBe(0)
    await deleteWorkspace(created.scope.projectId)
    expect(await db.screenplayScenes.count()).toBe(0)
  })
  it('禁止已有剧本调用小说改编 AI，跨 Work 来源读取也失败且无模型/Run 写入', async () => {
    const created = await create()
    const other = await create()
    const unit = await db.adaptationSourceUnits.where('adaptationProjectId').equals(created.adaptation.id!).first()
    const runAI = vi.fn()
    await expect(generateScreenplayProfessionalCandidateV1({ scope: created.scope, adaptationProjectId: created.adaptation.id!, stage: 'source-analysis', runAI })).rejects.toThrow('Phase 1')
    expect(runAI).not.toHaveBeenCalled()
    expect(await db.agentRuns.count()).toBe(0)
    await expect(startScreenplayProductionV1({ scope: created.scope, expectedAdaptationRevision: 1 })).rejects.toThrow('Phase 1')
    await expect(readAdaptationSourceContent({ targetScope: other.scope, adaptationProjectId: created.adaptation.id!, manifestVersion: 1, sourceUnitKeys: [unit!.sourceUnitKey] })).rejects.toThrow('不属于')
  })
  it('非法文本、写入中途失败或非法备份不留下半成品；来源 hash 损坏后停止编辑和导出', async () => {
    await expect(create('无标题')).rejects.toThrow()
    expect(await db.projects.count()).toBe(0)
    vi.spyOn(db.screenplayScenes, 'bulkAdd').mockRejectedValueOnce(new Error('write fault'))
    await expect(create()).rejects.toThrow('write fault')
    expect(await db.projects.count()).toBe(0)
    expect(await db.adaptationSourceUnits.count()).toBe(0)
    const created = await create()
    const backup = await exportProjectJSON(created.scope.projectId)
    const invalid = structuredClone(backup)
    invalid.screenplayScenes![0].blocks[0].source!.audienceVisible = false
    await expect(importProjectJSON(invalid)).rejects.toThrow()
    expect(await db.projects.count()).toBe(1)
    const altered = structuredClone(backup); altered.adaptationSourceUnits![0].sourceContent += 'tampered'
    await expect(importProjectJSON(altered)).rejects.toThrow('已变化')
    const unit = await db.adaptationSourceUnits.toCollection().first()
    await db.adaptationSourceUnits.update(unit!.id!, { sourceContent: script + 'tampered' })
    expect((await inspectAdaptationFreshness(created.adaptation.id!)).status).toBe('changed')
    await expect(exportExistingScreenplayV1(created.scope)).rejects.toThrow('已变化')
    await expect(updateScreenplayScene({ scope: created.scope, sceneId: created.scenes[0].id!, expectedRevision: 1, patch: { blocks: created.scenes[0].blocks } })).rejects.toThrow('已变化')
  })
})
