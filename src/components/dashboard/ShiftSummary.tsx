import { MetricCard } from '../ui/MetricCard.tsx'
import { formatPercent } from '../../lib/format.ts'
import type { MetricsView } from '../../lib/types.ts'

/**
 * Five display-only cards. "Shift summary" is a label for the current demo
 * session - it is not a shift-management entity.
 */
export function ShiftSummary({ metrics }: { metrics: MetricsView | null }) {
  const value = (amount: number | undefined) => (amount === undefined ? '—' : String(amount))

  return (
    <section aria-labelledby="shift-summary-heading" className="flex flex-col gap-3">
      <h2 id="shift-summary-heading" className="text-section font-semibold text-ink">
        Shift summary
      </h2>
      <div className="flex flex-wrap gap-3">
        <MetricCard label="Visitors" value={value(metrics?.visitors)} />
        <MetricCard label="Assigned Turns" value={value(metrics?.assignedTurns)} />
        <MetricCard label="Accepted Turns" value={value(metrics?.acceptedTurns)} />
        <MetricCard label="Closed Sales" value={value(metrics?.closedSales)} />
        <MetricCard
          label="Conversion Rate"
          value={metrics === null ? '—' : formatPercent(metrics.conversionRate)}
        />
      </div>
    </section>
  )
}
