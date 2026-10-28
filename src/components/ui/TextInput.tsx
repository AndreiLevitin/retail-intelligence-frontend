import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn.ts'

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> & {
  invalid?: boolean
}

export function TextInput({ invalid = false, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      type="text"
      aria-invalid={invalid || undefined}
      className={cn(
        'h-control min-h-touch w-full rounded-control border bg-surface px-3 text-body text-ink md:min-h-0',
        'placeholder:text-muted/70 disabled:cursor-not-allowed disabled:bg-neutral-tint',
        invalid ? 'border-danger' : 'border-line',
      )}
    />
  )
}
