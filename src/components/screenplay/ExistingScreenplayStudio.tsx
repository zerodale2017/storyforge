import { validateScreenplayBlocksV1 } from '../../lib/screenplay/contracts'
import { canonicalStringify } from '../../lib/agent/run/hash'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScreenplayBlock, ScreenplayScene, WorkspaceScope } from '../../lib/types'
import { listScreenplayScenes, setScreenplaySceneLocked, updateScreenplayScene } from '../../lib/screenplay/service'
import { exportExistingScreenplayV1 } from '../../lib/screenplay/existing-script-import'
import { readScreenplayAuthorDraft, saveScreenplayAuthorDraft } from '../../lib/screenplay/author-drafts'
import { queueCandidateDraftV1, flushCandidateDraftsV1 } from '../../lib/agent/candidate-draft-coordinator'
import { registerPendingDraftFlusherV1, flushPendingEditsV1 } from '../../lib/authoring/pending-edit-coordinator'
import './screenplay-studio.css'

const labels = { action: '动作', character: '角色', parenthetical: '括注', dialogue: '对白', transition: '转场', shot: '镜头', note: '注释', sound: '声音', screen: '画面信息', directing: '制作注' }
function textOf(block: ScreenplayBlock) { return block.type === 'character' ? block.name : block.text }
function download(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Existing scripts use the registered scene AST; no novel planning or model actions. */
export default function ExistingScreenplayStudio({ scope, page }: { scope: WorkspaceScope; page: string }) {
  const [scenes, setScenes] = useState<ScreenplayScene[]>([])
  const [editing, setEditing] = useState<ScreenplayScene | null>(null)
  const [original, setOriginal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const selectionSequence = useRef(0)
  const prefix = `existing-screenplay:${scope.workId}:`
  useEffect(() => registerPendingDraftFlusherV1(() => flushCandidateDraftsV1(prefix)), [prefix])
  const choose = useCallback(async (scene: ScreenplayScene) => {
    const sequence = ++selectionSequence.current
    await flushCandidateDraftsV1(prefix)
    const draft = await readScreenplayAuthorDraft(scope, `existing-scene:${scene.stableKey}:r${scene.revision}`)
    let next = scene
    if (draft && scene.status !== 'locked') {
      try {
        const blocks = JSON.parse(draft) as ScreenplayBlock[]
        if (!validateScreenplayBlocksV1(blocks).valid || blocks.length !== scene.blocks.length || blocks.some((block, i) => block.id !== scene.blocks[i].id || block.type !== scene.blocks[i].type || canonicalStringify(block.source) !== canonicalStringify(scene.blocks[i].source))) throw new Error('invalid author draft')
        next = { ...scene, blocks }
      } catch {
        if (sequence === selectionSequence.current) setError('编辑草稿格式无效，已显示正式保存的场景。原草稿记录仍保留在完整备份中。')
      }
    }
    if (sequence === selectionSequence.current) setEditing(next)
  }, [scope, prefix])
  const cancelSelection = useCallback(() => { selectionSequence.current++ }, [])
  useEffect(() => {
    let active = true
    void Promise.all([listScreenplayScenes(scope), exportExistingScreenplayV1(scope, true)]).then(async ([rows, text]) => {
      if (!active) return
      setScenes(rows); setOriginal(text)
      if (rows[0]) await choose(rows[0])
    }).catch(c => { if (active) setError(String(c)) })
    return () => { active = false; cancelSelection() }
  }, [scope, choose, cancelSelection])
  const changed = !!editing && JSON.stringify(editing.blocks) !== JSON.stringify(scenes.find(scene => scene.id === editing.id)?.blocks)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (c) { setError(String(c)) } finally { setBusy(false) }
  }
  const replaceBlock = (index: number, value: string) => {
    if (!editing) return
    const blocks = editing.blocks.map((block, i) => i !== index ? block : block.type === 'character' ? { ...block, name: value } : { ...block, text: value })
    setEditing({ ...editing, blocks })
    queueCandidateDraftV1({ key: `${prefix}${editing.id}`, draft: JSON.stringify(blocks), debounceMs: 250,
      persist: text => saveScreenplayAuthorDraft(scope, `existing-scene:${editing.stableKey}:r${editing.revision}`, text), onError: c => setError(c.message) })
  }
  const save = async () => {
    if (!editing) return
    await flushPendingEditsV1()
    const saved = await updateScreenplayScene({ scope, sceneId: editing.id!, expectedRevision: editing.revision, patch: { blocks: editing.blocks } })
    setScenes(rows => rows.map(row => row.id === saved.id ? saved : row)); setEditing(saved)
  }
  const toggleLock = async () => {
    if (!editing) return
    if (changed) throw new Error('请先保存场景，再改变锁定状态。')
    const saved = await setScreenplaySceneLocked({ scope, sceneId: editing.id!, expectedRevision: editing.revision, locked: editing.status !== 'locked' })
    setScenes(rows => rows.map(row => row.id === saved.id ? saved : row)); setEditing(saved)
  }
  if (page === 'source') return <section className="lf-paper"><h3>冻结原文</h3><p>已有剧本 · {scenes.length} 场。原始文字、标签、空行与前言完整保留。</p><details><summary>查看原文</summary><pre className="sp-import-original">{original}</pre></details>{error && <p role="alert">{error}</p>}</section>
  if (page === 'versions') return <section className="lf-paper"><h3>原格式导出</h3><p>导出保留原文格式。完整备份包含冻结原文、来源信息与手动修订。</p>{error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => void run(async () => { if (changed) throw new Error('请先保存场景，再导出修订稿。'); download(await exportExistingScreenplayV1(scope), '剧本-修订稿.txt') })}>导出修订稿 TXT</button><button disabled={busy} onClick={() => void run(async () => download(await exportExistingScreenplayV1(scope, true), '剧本-原始稿.txt'))}>导出原始稿 TXT</button></section>
  if (!['editor', 'scenes'].includes(page)) return <section className="lf-paper"><h3>已有剧本 · Phase 1</h3><p>当前支持导入、场次编辑、锁定及原格式导出。结构反推、观众视角分析、设定校验与 AI 改写将在后续阶段接入。</p></section>
  return <section className="lf-paper"><h3>已有剧本 · {scenes.length} 场</h3>{error && <p role="alert" className="sp-error">{error}</p>}<label>场次<select aria-label="已有剧本场次" disabled={busy} value={editing?.id ?? ''} onChange={e => { const scene = scenes.find(row => row.id === Number(e.target.value)); if (scene) void run(() => choose(scene)) }}>{scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.stableKey} · {scene.location} · {scene.timeOfDay}</option>)}</select></label>
    {editing && <><p>{editing.stableKey} · 修订 {editing.revision} · {editing.status === 'locked' ? '已锁定' : changed ? '有未保存修改，草稿自动保留' : '已保存'}</p><div className="sp-import-blocks">{editing.blocks.map((block, i) => <label key={block.id} className="sp-import-block"><strong>{labels[block.source?.kind ?? block.type]}{block.source?.audienceVisible === false ? ' · 制作说明' : ''}</strong><small>{block.id} · 原文第 {block.source?.startLine}～{block.source?.endLine} 行</small><textarea aria-label={`${block.id} 内容`} rows={block.type === 'character' ? 1 : 3} disabled={busy || editing.status === 'locked'} value={textOf(block)} onChange={e => replaceBlock(i, e.target.value)}/></label>)}</div><button disabled={busy || !changed || editing.status === 'locked'} onClick={() => void run(save)}>保存场景</button><button disabled={busy || changed} onClick={() => void run(toggleLock)}>{editing.status === 'locked' ? '解锁场景' : '锁定场景'}</button></>}
  </section>
}
