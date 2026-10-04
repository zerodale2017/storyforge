import type { ScreenplayBlock, ScreenplayBlockSourceV1, ScreenplayScene } from '../types'
import { canonicalStringify } from '../agent/run/hash'
import { validateScreenplayBlocksV1 } from './contracts'

export type ExistingScreenplaySceneV1 = Pick<ScreenplayScene, 'stableKey' | 'episodeNumber' | 'sceneNumber' | 'order' | 'intExt' | 'location' | 'timeOfDay' | 'blocks'>
const NAMED_ID = /^ep(\d{1,3})-(ed|post)$/i
const NAMED_HEADING = /^(\d{1,3})[—–-](ED|POST)(.+)$/i
const ID = /^ep(\d{1,3})-s(\d{1,4}[a-z]?)$/i
const NUMBERED = /^(\d{1,3})[—–-](\d{1,4}[a-z]?)([^a-z].+)$/i
const FOUNTAIN = /^(INT\.?\/EXT\.?|INT\.?|EXT\.?)\s+(.+)\s+-\s+(.+)$/i
const LABELS: Record<string, [ScreenplayBlock['type'], ScreenplayBlockSourceV1['kind']]> = {
  环境: ['action', 'action'], 动作: ['action', 'action'], 特写: ['shot', 'shot'], 镜头: ['shot', 'shot'],
  转场: ['transition', 'transition'], 声音: ['note', 'sound'], 画面信息: ['note', 'screen'],
  AI演绎注: ['note', 'directing'], 'Production note': ['note', 'directing'], 制作注: ['note', 'directing'],
  台词: ['dialogue', 'dialogue'], 对白: ['dialogue', 'dialogue'], 括注: ['parenthetical', 'parenthetical'],
}
interface Line { text: string; start: number; end: number; number: number }
function linesOf(text: string): Line[] {
  const lines: Line[] = []
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break
    const body = match[0].replace(/(?:\r\n|\r|\n)$/, '')
    lines.push({ text: body, start: match.index!, end: match.index! + body.length, number: lines.length + 1 })
  }
  return lines
}
function cue(line: string) { return /^([^：:。！？，、\s\r\n]{1,12}?)(?:〔([^〕]*)〕|（([^）]*)）)?[：:]$/.exec(line) }
function directing(line: string) { return /^(?:制作锁[｜|]|(?:R|v)\d+\.\d+.*(?:节奏锁|导演锁|节奏参考|片尾参考)|AI演绎注|Production note|【.*(?:Canon|制作锁))/i.test(line) || /身体控制[／/]视点|^完整ED.*黑屏/.test(line) }
function isLabel(line: string) { return Object.prototype.hasOwnProperty.call(LABELS, line) }
function boundary(line: string) { return isLabel(line) || !!cue(line) || directing(line) }

/** Labeled Chinese scripts and explicit INT/EXT headings. Unknown prose stays verbatim action. */
export function parseExistingScreenplayV1(text: string): { scenes: ExistingScreenplaySceneV1[] } {
  if (typeof text !== 'string' || !text.trim() || text.length > 5_000_000 || text.includes('\0')) throw new Error('[screenplay-import] 剧本必须为非空文本，至多 500 万字符，不能含 NUL')
  const lines = linesOf(text)
  const headings: Array<{ index: number; body: number; key: string; episode: number; number: number; heading: string; named?: boolean }> = []
  for (let i = 0; i < lines.length; i++) {
    const value = lines[i].text.trim()
    const named = NAMED_ID.exec(value)
    const id = ID.exec(value)
    const numbered = NUMBERED.exec(value)
    if (named) {
      const heading = NAMED_HEADING.exec(lines[i + 1]?.text.trim() ?? '')
      if (!heading || Number(heading[1]) !== Number(named[1]) || heading[2].toLowerCase() !== named[2].toLowerCase()) throw new Error(`[screenplay-import] 第 ${lines[i].number} 行片尾或彩蛋标题缺失或不符`)
      headings.push({ index: i, body: i + 2, key: value.toLowerCase(), episode: Number(named[1]), number: 0, heading: heading[3], named: true }); i++
    } else if (id) {
      const next = lines[i + 1]?.text.trim() ?? ''
      const heading = NUMBERED.exec(next)
      if (!heading || Number(heading[1]) !== Number(id[1]) || heading[2].toLowerCase() !== id[2].toLowerCase()) throw new Error(`[screenplay-import] 第 ${lines[i].number} 行场景标题缺失或与 ID 不符`)
      headings.push({ index: i, body: i + 2, key: value.toLowerCase(), episode: Number(id[1]), number: 0, heading: heading[3] }); i++
    } else if (numbered) {
      headings.push({ index: i, body: i + 1, key: `ep${numbered[1].padStart(2, '0')}-s${numbered[2].padStart(2, '0')}`, episode: Number(numbered[1]), number: 0, heading: numbered[3] })
    } else if (FOUNTAIN.test(value)) {
      headings.push({ index: i, body: i + 1, key: `scene-${String(headings.length + 1).padStart(3, '0')}`, episode: 1, number: headings.length + 1, heading: value })
    } else if (/^ep\d+-/i.test(value)) throw new Error(`[screenplay-import] 第 ${lines[i].number} 行场景 ID 非法`)
  }
  if (!headings.length || headings.length > 2000) throw new Error('[screenplay-import] 需包含 1～2000 个有明确标题的场景')
  const keys = new Set<string>()
  const identities = new Set<string>()
  const episodeCounts = new Map<number, number>()
  const scenes = headings.map((head, order): ExistingScreenplaySceneV1 => {
    head.number = (episodeCounts.get(head.episode) ?? 0) + 1
    episodeCounts.set(head.episode, head.number)
    const named = ID.exec(head.key)
    const identity = named ? `${Number(named[1])}:${Number.parseInt(named[2], 10)}:${named[2].replace(/\d/g, '')}` : head.key
    if (keys.has(head.key) || identities.has(identity) || head.episode < 1) throw new Error('[screenplay-import] 场景 ID 或场号重复')
    keys.add(head.key); identities.add(identity)
    const standard = FOUNTAIN.exec(head.heading)
    const parts = head.heading.split('·')
    const intExt: ScreenplayScene['intExt'] = standard ? (/^INT.*EXT/i.test(standard[1]) ? 'INT_EXT' : /^EXT/i.test(standard[1]) ? 'EXT' : 'INT') : /外.*内|内.*外/.test(parts[0]) ? 'INT_EXT' : /^外/.test(parts[0]) ? 'EXT' : /^内/.test(parts[0]) ? 'INT' : 'INT_EXT'
    if (!standard && (parts.length < 2 || parts.some(part => !part.trim()))) throw new Error('[screenplay-import] 场景标题须包含地点与时间，用 · 分隔')
    const end = headings[order + 1]?.index ?? lines.length
    const blocks: ScreenplayBlock[] = []
    const add = (type: ScreenplayBlock['type'], kind: ScreenplayBlockSourceV1['kind'], label: string, first: Line, last: Line, start = first.start, finish = last.end) => {
      const content = text.slice(start, finish)
      if (!content.trim()) throw new Error(`[screenplay-import] 第 ${first.number} 行缺少 ${label || type} 内容`)
      const source: ScreenplayBlockSourceV1 = { version: 1, kind, label, audienceVisible: kind !== 'directing', startLine: first.number, endLine: last.number, start, end: finish }
      const base = { id: `${head.key}-b${String(blocks.length + 1).padStart(3, '0')}`, source }
      blocks.push(type === 'character' ? { ...base, type, name: content } : { ...base, type, text: content })
    }
    for (let i = head.body; i < end;) {
      const first = lines[i], value = first.text.trim()
      if (!value) { i++; continue }
      const character = cue(value)
      if (character && !isLabel(value) && !directing(value)) {
        const nameStart = first.start + first.text.indexOf(character[1])
        add('character', 'character', '', first, first, nameStart, nameStart + character[1].length)
        const annotation = character[2] ?? character[3]
        if (annotation) { const start = first.start + first.text.indexOf(annotation, nameStart - first.start + character[1].length); add('parenthetical', 'parenthetical', '', first, first, start, start + annotation.length) }
        i++
        const begin = i
        while (i < end && lines[i].text.trim() && !boundary(lines[i].text.trim())) i++
        if (i === begin) throw new Error(`[screenplay-import] 第 ${first.number} 行角色 cue 缺少对白`)
        add('dialogue', 'dialogue', '', lines[begin], lines[i - 1])
        continue
      }
      const mapping = isLabel(value) ? LABELS[value] : undefined
      if (mapping) {
        const begin = ++i
        while (i < end && lines[i].text.trim() && !boundary(lines[i].text.trim())) i++
        if (i === begin) throw new Error(`[screenplay-import] 第 ${first.number} 行标签缺少内容`)
        add(mapping[0], mapping[1], value, lines[begin], lines[i - 1])
      } else {
        const isDirecting = directing(value)
        let last = i++
        while (i < end && lines[i].text.trim() && !boundary(lines[i].text.trim())) last = i++
        add(isDirecting ? 'note' : 'action', isDirecting ? 'directing' : 'action', '', first, lines[last])
      }
    }
    const report = validateScreenplayBlocksV1(blocks)
    if (!blocks.length || !report.valid) throw new Error(`[screenplay-import] ${head.key}: ${report.issues.map(issue => issue.message).join('；') || '场景为空'}`)
    const explicitMode = /^(?:内(?:[／/]外)?|外(?:[／/]内)?|内外)$/.test(parts[0])
    const location = standard?.[2] ?? (head.named ? head.heading : explicitMode ? parts.length === 2 ? parts[1] : parts.slice(1, -1).join('·') : parts.slice(0, -1).join('·'))
    const timeOfDay = standard?.[3] ?? (head.named || (parts.length === 2 && explicitMode) ? '未注明' : parts[parts.length - 1])
    return { stableKey: head.key, episodeNumber: head.episode, sceneNumber: head.number, order, intExt, location, timeOfDay, blocks }
  })
  return { scenes }
}

/** Replaces only source-backed text ranges; changed structure/headings require an explicit new format export. */
export function serializeExistingScreenplayV1(original: string, scenes: ExistingScreenplaySceneV1[]): string {
  const baseline = parseExistingScreenplayV1(original).scenes
  if (baseline.length !== scenes.length) throw new Error('[screenplay-import] 场次结构已变化，不能按原格式导出')
  const replacements: Array<{ start: number; end: number; value: string }> = []
  baseline.forEach((before, index) => {
    const after = scenes[index]
    for (const key of ['stableKey', 'episodeNumber', 'sceneNumber', 'order', 'intExt', 'location', 'timeOfDay'] as const) if (before[key] !== after[key]) throw new Error('[screenplay-import] 标题或顺序已变化，不能按原格式导出')
    if (before.blocks.length !== after.blocks.length || !validateScreenplayBlocksV1(after.blocks).valid) throw new Error('[screenplay-import] 段落结构已变化或非法')
    before.blocks.forEach((block, i) => {
      const next = after.blocks[i]
      if (block.id !== next.id || block.type !== next.type || canonicalStringify(block.source) !== canonicalStringify(next.source)) throw new Error('[screenplay-import] 段落身份或来源已变化')
      if (next.type === 'character' && (next.extension || next.dualDialogue || next.characterId != null)) throw new Error('[screenplay-import] 角色 cue 结构已变化')
      const edited = next.type === 'character' ? next.name : next.text
      const beforeText = block.type === 'character' ? block.name : block.text
      const eol = /\r\n|\r|\n/.exec(beforeText)?.[0] ?? /\r\n|\r|\n/.exec(original)?.[0] ?? '\n'
      const value = edited === beforeText ? edited : edited.replace(/\r\n|\r|\n/g, eol)
      replacements.push({ start: block.source!.start, end: block.source!.end, value })
    })
  })
  let result = original
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end)
  // Never export text that parses to a different structure after user edits.
  const valueOf = (block: ScreenplayBlock) => (block.type === 'character' ? block.name : block.text).replace(/\r\n|\r/g, '\n')
  const reparsed = parseExistingScreenplayV1(result).scenes
  if (reparsed.length !== scenes.length || reparsed.some((scene, i) => scene.blocks.length !== scenes[i].blocks.length || scene.blocks.some((block, j) => block.type !== scenes[i].blocks[j].type || valueOf(block) !== valueOf(scenes[i].blocks[j])))) throw new Error('[screenplay-import] 编辑引入了标签或结构歧义，不能按原格式导出')
  return result
}
