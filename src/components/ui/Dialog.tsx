import { useCallback, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Button } from './Button.tsx'

interface DialogProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  /** Rendered in the footer; the caller owns submit wiring. */
  footer: ReactNode
  children: ReactNode
  /** Blocks Escape and the close button while a command is in flight. */
  busy?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Labelled modal with keyboard close, a contained Tab cycle and focus
 * restoration. Used for create/edit profile, record exit and reset confirmation.
 */
export function Dialog({ open, title, description, onClose, footer, children, busy = false }: DialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<Element | null>(null)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busy) {
          event.preventDefault()
          onClose()
        }
        return
      }
      if (event.key !== 'Tab' || panelRef.current === null) return

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
    },
    [busy, onClose],
  )

  useEffect(() => {
    if (!open) return
    restoreFocusTo.current = document.activeElement
    const panel = panelRef.current
    const target = panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel
    target?.focus()

    document.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (restoreFocusTo.current instanceof HTMLElement) restoreFocusTo.current.focus()
    }
  }, [handleKeyDown, open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className="panel my-auto w-full max-w-lg p-6 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-section font-semibold text-ink">
              {title}
            </h2>
            {description !== undefined ? (
              <p id={descriptionId} className="text-body text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button variant="text" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>

        <div className="mt-6 flex flex-col gap-4">{children}</div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}
