// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MockBoardClient } from './services/mockBoardClient.ts'

// This smoke test always exercises the mock-mode review path, regardless of
// the developer's local .env.local (which is free to point the real dev
// server at VITE_BOARD_CLIENT=http). Stubbing the services module - rather
// than relying on ambient env - keeps that intent explicit and the test
// hermetic (no network, deterministic every run).
vi.mock('./services/index.ts', () => {
  const client = new MockBoardClient('empty')
  return {
    boardService: client,
    boardServiceMode: 'mock' as const,
    mockController: client,
    httpClient: null,
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the shell and dashboard without throwing', async () => {
  const { default: App } = await import('./App.tsx')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<App />)
    // Let the mock client's simulated read latency (180ms) resolve so the
    // dashboard moves past its initial loading state.
    await new Promise((resolve) => setTimeout(resolve, 400))
  })

  const html = container.innerHTML
  expect(html).toContain('Digital UP Board')
  expect(html).toContain('Shift summary')
  expect(html).toContain('Coming soon')
  expect(html).toContain('Visitors')
  expect(html).toContain('Associates')
  expect(html).toContain('Add Visitor')
  expect(html).toContain('Reset Demo')
  expect(html).toContain('Mock mode')

  await act(async () => {
    root.unmount()
  })
})
