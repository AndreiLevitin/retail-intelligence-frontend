import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'text'
export type ButtonSize = 'md' | 'sm'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a pending label and blocks the click without hiding the action. */
  pending?: boolean
  children: ReactNode
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-ink border-primary hover:bg-primary-hover',
  secondary: 'bg-surface text-ink border-line hover:bg-neutral-tint',
  destructive: 'bg-surface text-danger border-danger/40 hover:bg-danger-tint',
  text: 'bg-transparent text-primary border-transparent hover:bg-info-tint',
}

/**
 * Every key action is a text label, not an icon only, so it stays
 * discoverable without hover and readable by assistive technology.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  disabled = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control',
        'border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md' ? 'h-control px-4 text-body md:min-h-0 min-h-touch' : 'h-8 px-3 text-label',
        variantClasses[variant],
      )}
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="size-2 animate-pulse rounded-full bg-current"
        />
      ) : null}
      {children}
    </button>
  )
}
