import type { ReactNode } from 'react'

interface FormFieldProps {
  id: string
  label: string
  /** Required / optional semantics are stated, never implied by an asterisk alone. */
  optional?: boolean
  hint?: string
  error?: string
  children: ReactNode
}

export function FormField({ id, label, optional = false, hint, error, children }: FormFieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`
  const errorId = error === undefined ? undefined : `${id}-error`

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label font-medium text-muted">
        {label}
        {optional ? <span className="font-normal"> (optional)</span> : null}
      </label>
      {children}
      {hint !== undefined ? (
        <p id={hintId} className="text-label text-muted">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-label text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
