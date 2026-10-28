/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` for frontend review, `http` for the real Vercel API. */
  readonly VITE_BOARD_CLIENT?: 'mock' | 'http'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
