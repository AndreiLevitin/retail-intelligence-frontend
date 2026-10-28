import type { SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/cn.ts'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

type SelectProps<T extends string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'value' | 'onChange' | 'children'
> & {
  value: T
  options: readonly SelectOption<T>[]
  onValueChange: (value: T) => void
  invalid?: boolean
}

/**
 * Standard native select. Demographic selects always include an explicit
 * Unknown option supplied by the caller - it is a real value, not a blank.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  invalid = false,
  ...rest
}: SelectProps<T>) {
  return (
    <select
      {...rest}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(event) => onValueChange(event.target.value as T)}
      className={cn(
        'h-control min-h-touch w-full rounded-control border bg-surface px-3 text-body text-ink md:min-h-0',
        'disabled:cursor-not-allowed disabled:bg-neutral-tint',
        invalid ? 'border-danger' : 'border-line',
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
