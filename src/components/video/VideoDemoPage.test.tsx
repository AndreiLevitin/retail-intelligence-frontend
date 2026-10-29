// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { VideoDemoPage } from './VideoDemoPage.tsx'

const mocks = vi.hoisted(() => ({ get: vi.fn(), reset: vi.fn(), start: vi.fn() }))
vi.mock('../../services/index.ts', () => ({ boardServiceMode: 'http' }))
vi.mock('../../services/videoDemo.ts', () => ({
  getVideoStatus: mocks.get, resetVideoDemo: mocks.reset, startVideoDemo: mocks.start,
  videoUrl: (path: string) => path,
}))

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

it('clears the completed run and players while keeping playback backup available', async () => {
  const idle = { phase: 'idle', logs: [], backupAvailable: true }
  mocks.get.mockResolvedValue({ phase: 'completed', jobId: 'job', frames: 81,
    registered: 2, backupAvailable: true, resultPath: '/media/result/job',
    logs: [{ at: '2026-10-29T12:00:00Z', message: 'Previous registration' }] })
  mocks.reset.mockImplementation(async () => { mocks.get.mockResolvedValue(idle); return idle })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<VideoDemoPage active onBoard={() => {}} />) })
    expect(container.querySelectorAll('video')).toHaveLength(2)
    expect(container.textContent).toContain('2 visitors registered')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Reset video')!
    await act(async () => { button.click() })
    expect(mocks.reset).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(container.querySelectorAll('video')).toHaveLength(1)
    expect(container.textContent).toContain('Ready to process')
    expect(container.textContent).toContain('0 visitors registered')
    expect(container.textContent).not.toContain('Previous registration')
    expect(container.textContent).toContain('Play recorded result')
    expect(pause).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
  } finally { await act(async () => { root.unmount() }) }
})
