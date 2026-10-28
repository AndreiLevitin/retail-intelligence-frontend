import { Button } from '../ui/Button.tsx'

interface TopBarProps {
  onToggleSidebar: () => void
  sidebarOpen: boolean
}

/**
 * Text wordmark plus two deliberately non-functional placeholders. They are
 * disabled and labelled as unavailable; no search, account menu or settings
 * workflow exists in this prototype.
 */
export function TopBar({ onToggleSidebar, sidebarOpen }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-line bg-surface px-4">
      {/* The desktop rail is static, so the toggle only exists on tablet. */}
      <span className="lg:hidden">
        <Button
          variant="secondary"
          size="sm"
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
        >
          Menu
        </Button>
      </span>

      <span className="text-section font-semibold tracking-tight text-ink">Digital UP Board</span>

      <div className="ml-auto flex items-center gap-3">
        <input
          type="search"
          disabled
          aria-label="Search (unavailable in this prototype)"
          placeholder="Search unavailable"
          className="hidden h-9 w-56 rounded-control border border-line bg-neutral-tint px-3 text-body text-muted sm:block"
        />
        <span
          aria-disabled="true"
          title="Account menu unavailable in this prototype"
          className="flex size-9 items-center justify-center rounded-full border border-line bg-neutral-tint text-label font-semibold text-muted"
        >
          <span className="sr-only">User account placeholder, unavailable</span>
          <span aria-hidden="true">RC</span>
        </span>
      </div>
    </header>
  )
}
