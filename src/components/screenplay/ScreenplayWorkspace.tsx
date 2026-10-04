import { lazy, Suspense, useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import { db } from '../../lib/db/schema'
import type { WorkspaceScope } from '../../lib/types'
const AdaptationStudio = lazy(() => import('./ScreenplayStudio'))
const ExistingStudio = lazy(() => import('./ExistingScreenplayStudio'))
export default function ScreenplayWorkspace({ scope, page }: { scope: WorkspaceScope; page: string }) {
  const [existing, setExisting] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const subscription = liveQuery(() => db.adaptationProjects.where('workId').equals(scope.workId).first()).subscribe({
      next: root => setExisting(root?.sourceSelectionMode === 'existing-script'), error: c => setError(String(c)),
    })
    return () => subscription.unsubscribe()
  }, [scope.workId])
  if (error) return <p role="alert">{error}</p>
  if (existing === null) return <p>读取剧本…</p>
  return <Suspense fallback={<p>读取剧本…</p>}>{existing ? <ExistingStudio scope={scope} page={page}/> : <AdaptationStudio scope={scope} page={page}/>}</Suspense>
}
