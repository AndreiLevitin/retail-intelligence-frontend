import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { Button } from './Button.tsx'

export type NoticeTone = 'error' | 'warning' | 'success' | 'info'

interface NoticeProps {
  tone: NoticeTone
  title: string
  children?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  onDismiss?: () => void
  retryPending?: boolean
}

const toneClasses: Record<NoticeTone, string> = {
  error: 'border-danger/30 bg-danger-tint text-danger',
  warning: 'border-warning/30 bg-warning-tint text-warning',
  success: 'border-success/30 bg-success-tint text-success',
  info: 'border-info/30 bg-info-tint text-info',
}

/**
 * Short operator-facing message with an optional retry path. A rejected
 * command is an error here; No-Sale is a normal outcome and never appears.
 */
export function Notice({
  tone,
  title,
  children,
  onRetry,
  retryLabel = 'Retry',
  onDismiss,
  retryPending = false,
}: NoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border px-4 py-3', toneClasses[tone])}
    >
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        {children !== undefined ? <div className="text-body">{children}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onRetry !== undefined ? (
          <Button variant="secondary" size="sm" onClick={onRetry} pending={retryPending}>
            {retryLabel}
          </Button>
        ) : null}
        {onDismiss !== undefined ? (
          <Button variant="text" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  )
}
