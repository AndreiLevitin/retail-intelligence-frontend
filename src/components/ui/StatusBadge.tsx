import { cn } from '../../lib/cn.ts'
import type { Tone } from '../../lib/labels.ts'

interface StatusBadgeProps {
  tone: Tone
  children: string
}

const toneClasses: Record<Tone, string> = {
  success: 'bg-success-tint text-success border-success/20',
  warning: 'bg-warning-tint text-warning border-warning/20',
  danger: 'bg-danger-tint text-danger border-danger/20',
  info: 'bg-info-tint text-info border-info/20',
  neutral: 'bg-neutral-tint text-ink border-line',
  muted: 'bg-transparent text-muted border-line',
}

/** Always text plus a semantic tint; state is never communicated by colour alone. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-control border px-2 py-0.5 text-label font-medium whitespace-nowrap',
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  )
}
