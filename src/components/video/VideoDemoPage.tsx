import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button.tsx'
import { boardServiceMode } from '../../services/index.ts'
import { getVideoStatus, resetVideoDemo, startVideoDemo, videoUrl } from '../../services/videoDemo.ts'
import type { VideoDemoStatus } from '../../services/videoDemo.ts'

const LABELS = { idle: 'Ready to process', starting: 'Loading detector', processing: 'Processing video',
  completed: 'Processing complete', failed: 'Processing stopped' }

export function VideoDemoPage({ active, onBoard }: { active: boolean; onBoard: () => void }) {
  const [status, setStatus] = useState<VideoDemoStatus>({ phase: 'idle', logs: [], backupAvailable: false })
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [backup, setBackup] = useState(false)
  const generation = useRef(0)
  const source = useRef<HTMLVideoElement>(null)
  const real = boardServiceMode === 'http'
  const busy = starting || status.phase === 'starting' || status.phase === 'processing'

  useEffect(() => {
    if (!active || !real) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const version = generation.current
      try {
        const next = await getVideoStatus()
        if (!disposed && version === generation.current) { setStatus(next); setError(null) }
      } catch (reason) {
        if (!disposed && version === generation.current) setError((reason as Error).message)
      }
      if (!disposed) timer = setTimeout(poll, 1000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, real])

  async function start() {
    generation.current++
    setStarting(true); setError(null); setBackup(false)
    try {
      const next = await startVideoDemo()
      generation.current++
      setStatus(next)
      if (source.current) {
        source.current.currentTime = 0
        void source.current.play().catch(() => {})
      }
    } catch (reason) { setError((reason as Error).message) }
    finally { setStarting(false) }
  }

  async function reset() {
    generation.current++
    setResetting(true); setError(null)
    try {
      const next = await resetVideoDemo()
      generation.current++
      setStatus(next); setBackup(false)
      source.current?.pause()
      source.current?.load()
    } catch (reason) { setError((reason as Error).message) }
    finally { setResetting(false) }
  }

  const result = backup ? '/media/backup' : status.resultPath

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Video demo</h1>
          <p className="mt-1 text-body text-muted">A detected entrance becomes a visitor on the UP Board.</p>
        </div>
        <Button onClick={onBoard}>Open UP Board</Button>
      </header>
      {!real && <p role="status" className="rounded-control border border-line bg-surface p-4 text-muted">Connect to the real backend to register visitors from video.</p>}
      {error && <p role="alert" className="rounded-control border border-danger/40 bg-danger-tint p-4 text-danger">{error}</p>}
      <section className="flex flex-wrap items-center gap-4 rounded-control border border-line bg-surface p-4">
        <Button variant="primary" onClick={() => void start()} disabled={!real || busy || resetting} pending={busy}>
          {busy ? 'Processing…' : status.jobId ? 'Process again' : 'Start processing'}
        </Button>
        <Button onClick={() => void reset()} disabled={!real || busy} pending={resetting}>Reset video</Button>
        <div className="flex-1" aria-live="polite">
          <p className="font-semibold text-ink">{LABELS[status.phase]}</p>
          <p className="text-body text-muted">{status.frames ?? 0} / {status.totalFrames ?? 81} frames · {status.registered ?? 0} visitors registered</p>
        </div>
        {status.backupAvailable && <Button onClick={() => setBackup(true)}>Play recorded result</Button>}
      </section>
      {status.error && <p role="alert" className="text-danger">{status.error}</p>}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-control border border-line bg-surface p-4">
          <h2 className="mb-3 font-semibold text-ink">Source video · 2.7 seconds</h2>
          <video ref={source} controls preload="metadata" className="aspect-video w-full rounded-control bg-black" src={real ? videoUrl('/media/source') : undefined} />
          <p className="mt-2 text-body text-muted">Prerecorded entrance sample. Processing runs independently of playback.</p>
        </section>
        <section className="rounded-control border border-line bg-surface p-4">
          <h2 className="mb-3 font-semibold text-ink">{backup ? 'Recorded result · no new registrations' : 'Processed video'}</h2>
          {result ? <video key={result} controls preload="metadata" className="aspect-video w-full rounded-control bg-black" src={videoUrl(result)} /> :
            <div className="flex aspect-video items-center justify-center rounded-control bg-page p-6 text-center text-muted">{busy ? 'Visitors appear on the board during processing. The annotated video will be ready at the end.' : 'Start processing to see people, track IDs and the entrance line.'}</div>}
        </section>
      </div>
      <section className="rounded-control border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold text-ink">Processing activity</h2>
        {status.logs.length ? <ol className="flex flex-col gap-2 text-body text-ink">{status.logs.map((entry, index) =>
          <li key={`${entry.at}-${index}`}><time className="mr-3 text-muted">{new Date(entry.at).toLocaleTimeString()}</time>{entry.message}</li>)}</ol> :
          <p className="text-body text-muted">Detected entrances and visitor registrations will appear here.</p>}
      </section>
    </div>
  )
}
