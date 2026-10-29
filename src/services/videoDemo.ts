import { httpClient } from './index.ts'

export interface VideoDemoStatus {
  phase: 'idle' | 'starting' | 'processing' | 'completed' | 'failed'
  jobId?: string
  frames?: number
  totalFrames?: number
  arrivals?: number
  registered?: number
  resultPath?: string | null
  backupAvailable: boolean
  error?: string | null
  logs: { at: string; message: string }[]
}

// Vite's /cv-demo proxy exists only in development. Hosted UI talks directly
// to the presenter's loopback companion, subject to browser network permission.
const BASE = (import.meta.env.VITE_CV_BASE_URL ??
  (import.meta.env.DEV ? '/cv-demo' : 'http://127.0.0.1:8765')).replace(/\/$/, '')
export const videoUrl = (path: string) => BASE + path

async function request<T>(path: string, body?: unknown): Promise<T> {
  const token = httpClient?.getToken()
  if (!token) throw new Error('Connect to the real board before starting video processing.')
  let response: Response
  try {
    response = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Cannot reach the local video runner. Start cv_engine.py serve and allow local access in the browser.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.message ?? 'The local video runner is unavailable.')
  return data as T
}

export const getVideoStatus = () => request<VideoDemoStatus>('/status')
export const resetVideoDemo = () => request<VideoDemoStatus>('/reset', {})
export async function startVideoDemo(): Promise<VideoDemoStatus> {
  if (!httpClient) throw new Error('Video arrivals require the real backend, not mock mode.')
  const board = await httpClient.getBoard()
  return request('/runs', { sessionId: board.session.sessionId })
}
