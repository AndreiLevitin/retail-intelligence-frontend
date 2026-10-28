/**
 * Single place that decides which BoardService implementation the app uses.
 *
 * `VITE_BOARD_CLIENT=mock|http` selects the adapter. A deployment never falls
 * back to mock data after a real API error: the choice is made once, at
 * startup, and a failing HTTP client keeps failing visibly.
 */
import { HttpBoardClient } from './httpBoardClient.ts'
import { MockBoardClient } from './mockBoardClient.ts'
import type { BoardService, BoardServiceMode } from './boardService.ts'

function resolveMode(): BoardServiceMode {
  const configured = import.meta.env.VITE_BOARD_CLIENT
  if (configured === 'http') return 'http'
  if (configured === 'mock') return 'mock'
  // Unconfigured: mock for local review, HTTP for a real build.
  return import.meta.env.DEV ? 'mock' : 'http'
}

export const boardServiceMode: BoardServiceMode = resolveMode()

export const boardService: BoardService =
  boardServiceMode === 'mock' ? new MockBoardClient() : new HttpBoardClient()

/** Non-null only in mock mode; drives the review panel. */
export const mockController: MockBoardClient | null =
  boardService instanceof MockBoardClient ? boardService : null

/** Non-null only in HTTP mode; receives the operator token from the prompt. */
export const httpClient: HttpBoardClient | null =
  boardService instanceof HttpBoardClient ? boardService : null

export type { BoardService } from './boardService.ts'
