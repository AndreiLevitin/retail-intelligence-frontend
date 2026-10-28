import { cn } from '../../lib/cn.ts'

/**
 * Only Dashboard is implemented. The remaining entries are visibly marked
 * Coming soon and are not links - there is no destination and no fake
 * navigation behind them.
 */
const NAV_ITEMS = [
  { label: 'Dashboard', available: true },
  { label: 'Analytics', available: false },
  { label: 'Company', available: false },
  { label: 'Support', available: false },
] as const

interface SidebarProps {
  /** Tablet drawer state. Ignored on desktop where the rail is static. */
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
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
                <span
                  aria-current="page"
                  className="flex min-h-touch items-center rounded-control bg-info-tint px-3 text-body font-semibold text-primary lg:min-h-10"
                >
                  {item.label}
                </span>
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
