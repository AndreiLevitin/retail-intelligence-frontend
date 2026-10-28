import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Notice } from '../ui/Notice.tsx'

interface ResetDialogProps {
  open: boolean
  pending: boolean
  errorMessage?: string
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive-action confirmation for Reset Demo, stated in product terms. */
export function ResetDialog({ open, pending, errorMessage, onConfirm, onCancel }: ResetDialogProps) {
  return (
    <Dialog
      open={open}
      title="Reset Demo"
      description="This clears the current demo session."
      onClose={onCancel}
      busy={pending}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" pending={pending} onClick={onConfirm}>
            Reset demo
          </Button>
        </>
      }
    >
      {errorMessage === undefined ? null : <Notice tone="error" title={errorMessage} />}

      <ul className="list-disc space-y-1 pl-5 text-body text-ink">
        <li>All visits, turns and activity from this demo session are removed.</li>
        <li>A new session start time is created and metrics return to zero.</li>
        <li>The three predefined associates are reseeded Available in their initial order.</li>
      </ul>
      <p className="text-body text-muted">
        The persistent associate roster itself is not deleted. Actions stay blocked until the new board loads.
      </p>
    </Dialog>
  )
}
