import { useState } from 'react'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Notice } from '../ui/Notice.tsx'
import { StatusBadge } from '../ui/StatusBadge.tsx'
import { describeAppearance, outcomeLabel, outcomeTone } from '../../lib/labels.ts'
import type { Outcome, VisitView } from '../../lib/types.ts'

interface ExitDialogProps {
  visit: VisitView
  /** Resolved separately: a visit only carries an assignmentId on the wire. */
  associateName: string | null
  pending: boolean
  errorMessage?: string
  onCommit: (outcome: Outcome | null) => void
  onCancel: () => void
}

const OUTCOME_CHOICES: ReadonlyArray<{ value: Outcome; label: string }> = [
  { value: 'Sale', label: 'Sale' },
  { value: 'NoSale', label: 'No-Sale' },
]

/**
 * Records a departure. A missing purchase result must be chosen explicitly
 * before committing; an existing one is shown read-only and preserved.
 *
 * A Waiting visitor can leave with no assignment at all - the outcome belongs
 * to the visit, not to a turn.
 *
 * `visit` is the live row, so the dialog follows server state while open; the
 * component is mounted per opening, which keeps the selection stable.
 */
export function ExitDialog({ visit, associateName, pending, errorMessage, onCommit, onCancel }: ExitDialogProps) {
  const [choice, setChoice] = useState<Outcome | null>(null)

  const hasResult = visit.outcome !== null
  const canCommit = hasResult || choice !== null

  return (
    <Dialog
      open
      title="Mark Exit"
      description="The server records the exit time and closes any unfinished service."
      onClose={onCancel}
      busy={pending}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!canCommit}
            onClick={() => onCommit(hasResult ? null : choice)}
          >
            Record exit
          </Button>
        </>
      }
    >
      {errorMessage === undefined ? null : <Notice tone="error" title={errorMessage} />}

      <dl className="grid gap-2 rounded-panel border border-line bg-page p-4 text-body">
        <div className="flex gap-2">
          <dt className="text-muted">Visitor</dt>
          <dd className="text-ink">{describeAppearance(visit.attributes)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">Assigned associate</dt>
          <dd className="text-ink">{associateName ?? 'None'}</dd>
        </div>
      </dl>

      {hasResult ? (
        <div className="flex flex-col gap-2">
          <span className="text-label font-medium text-muted">Purchase result (already recorded)</span>
          <div>
            <StatusBadge tone={outcomeTone(visit.outcome)}>{outcomeLabel(visit.outcome)}</StatusBadge>
          </div>
          <p className="text-label text-muted">
            The existing result is preserved; the exit does not change it.
          </p>
        </div>
      ) : (
        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <legend className="text-label font-medium text-muted">Purchase result (required)</legend>
          {OUTCOME_CHOICES.map((option) => (
            <label
              key={option.value}
              className="flex min-h-touch items-center gap-3 rounded-control border border-line bg-surface px-3 text-body lg:min-h-10"
            >
              <input
                type="radio"
                name="exit-purchase-result"
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
              />
              {option.label}
            </label>
          ))}
          <p className="text-label text-muted">
            No-Sale is a normal outcome. A result is required because this visit has none recorded yet.
          </p>
        </fieldset>
      )}
    </Dialog>
  )
}
