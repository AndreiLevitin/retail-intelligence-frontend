/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` for frontend review, `http` for the real backend API. */
  readonly VITE_BOARD_CLIENT?: 'mock' | 'http'
  /**
   * Absolute origin of the separate backend deployment (e.g.
   * `https://api.example.com` or `http://localhost:3000`), no trailing
   * slash. Unset means relative `/api/...` paths - only correct when a dev
   * proxy or reverse proxy puts both projects behind one origin.
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
