import { cn } from '../../lib/cn.ts'

/**
 * Dashboard and the explicitly requested local Video demo are implemented. Other entries are marked
 * Coming soon and are not links - there is no destination and no fake
 * navigation behind them.
 */
const NAV_ITEMS = [
  { label: 'Dashboard', available: true },
  { label: 'Video demo', available: true },
  { label: 'Analytics', available: false },
  { label: 'Company', available: false },
  { label: 'Support', available: false },
] as const

interface SidebarProps {
  /** Tablet drawer state. Ignored on desktop where the rail is static. */
  open: boolean
  onClose: () => void
  page: 'Dashboard' | 'Video demo'
  onNavigate: (page: 'Dashboard' | 'Video demo') => void
}

export function Sidebar({ open, onClose, page, onNavigate }: SidebarProps) {
  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}

      <nav
        id="app-sidebar"
        aria-label="Main"
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-sidebar shrink-0 border-r border-line bg-surface',
          'transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <ul className="flex flex-col gap-1 p-3">
          {NAV_ITEMS.map((item) =>
            item.available ? (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => { onNavigate(item.label); onClose() }}
                  aria-current={page === item.label ? 'page' : undefined}
                  className={cn('flex w-full min-h-touch items-center rounded-control px-3 text-body font-semibold lg:min-h-10', page === item.label ? 'bg-info-tint text-primary' : 'text-ink hover:bg-neutral-tint')}
                >
                  {item.label}
                </button>
              </li>
            ) : (
              <li key={item.label}>
                <span
                  aria-disabled="true"
                  className="flex min-h-touch items-center justify-between gap-2 rounded-control px-3 text-body text-muted lg:min-h-10"
                >
                  {item.label}
                  <span className="rounded-control border border-line px-1.5 py-0.5 text-label">
                    Coming soon
                  </span>
                </span>
              </li>
            ),
          )}
        </ul>
      </nav>
    </>
  )
}
