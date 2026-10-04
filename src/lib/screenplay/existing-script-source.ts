import type { AdaptationProject, AdaptationSourceUnit } from '../types'
import { hashCanonicalValue } from '../agent/run/hash'
import { assertAdaptationProjectInvariant } from '../adaptation/contracts'

/** One immutable text snapshot, owned by the screenplay Work through PROJECT_TABLES. */
export async function assertExistingScriptSourceV1(root: AdaptationProject, units: AdaptationSourceUnit[]): Promise<string> {
  assertAdaptationProjectInvariant(root)
  if (root.sourceSelectionMode !== 'existing-script' || units.length !== 1) throw new Error('[screenplay-import] 原文来源缺失或数量非法')
  const unit = units[0]
  if (unit.adaptationProjectId !== root.id || unit.projectId !== root.projectId || unit.workId !== root.workId
    || unit.manifestVersion !== 1 || unit.sourceKind !== 'screenplay' || unit.order !== 0
    || unit.sourceOutlineNodeId !== null || unit.sourceChapterId !== null
    || !/^asu_[A-Za-z0-9_-]{8,64}$/.test(unit.sourceUnitKey)
    || typeof unit.sourceContent !== 'string' || !unit.sourceContent.trim() || unit.sourceContent.length > 5_000_000
    || unit.sourceContent.includes('\0')) throw new Error('[screenplay-import] 原文来源归属或内容非法')
  const actualHash = await hashCanonicalValue(unit.sourceContent)
  if (unit.contentHash !== actualHash || root.activeSourceManifestHash !== actualHash) throw new Error('[screenplay-import] 冻结原文已变化，请恢复完整备份')
  return unit.sourceContent
}
