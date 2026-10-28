interface MetricCardProps {
  label: string
  /** Already formatted by the caller. Display only - no interaction. */
  value: string
}

export function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="panel flex min-w-40 flex-1 flex-col gap-1 p-4">
      <span className="text-label font-medium tracking-wide text-muted uppercase">{label}</span>
      <span className="text-metric font-semibold text-ink">{value}</span>
    </div>
  )
}
