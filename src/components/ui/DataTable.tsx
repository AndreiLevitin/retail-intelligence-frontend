import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  /** Tailwind width class, e.g. `w-40`. */
  width?: string
  align?: 'left' | 'right'
  /** Action columns keep a visible header for screen readers only. */
  headerHidden?: boolean
}

export type TableState = 'loading' | 'error' | 'ready'

interface DataTableProps<T> {
  /** Accessible table name. */
  caption: string
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  state?: TableState
  emptyMessage: string
  errorMessage?: string
  /** Extra classes for a row, e.g. muting a departed visitor. */
  rowClassName?: (row: T) => string | undefined
}

/**
 * Header, stable rows, explicit empty / loading / error states and a local
 * horizontal scroll container so the page itself never scrolls sideways.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  state = 'ready',
  emptyMessage,
  errorMessage,
  rowClassName,
}: DataTableProps<T>) {
  const body = (() => {
    if (state === 'loading') {
      return <StatusRow colSpan={columns.length}>Loading…</StatusRow>
    }
    if (state === 'error') {
      return (
        <StatusRow colSpan={columns.length} tone="danger">
          {errorMessage ?? 'Could not load this table.'}
        </StatusRow>
      )
    }
    if (rows.length === 0) {
      return <StatusRow colSpan={columns.length}>{emptyMessage}</StatusRow>
    }
    return rows.map((row) => (
      <tr key={rowKey(row)} className={cn('border-t border-line align-middle', rowClassName?.(row))}>
        {columns.map((column) => (
          <td
            key={column.key}
            className={cn(
              'min-h-row px-4 py-3 text-body',
              column.align === 'right' ? 'text-right' : 'text-left',
              column.width,
            )}
          >
            {column.cell(row)}
          </td>
        ))}
      </tr>
    ))
  })()

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-3xl border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-neutral-tint">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-4 py-2 text-label font-semibold tracking-wide text-muted uppercase',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  column.width,
                )}
              >
                {column.headerHidden === true ? <span className="sr-only">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  )
}

function StatusRow({
  colSpan,
  tone = 'muted',
  children,
}: {
  colSpan: number
  tone?: 'muted' | 'danger'
  children: ReactNode
}) {
  return (
    <tr className="border-t border-line">
      <td
        colSpan={colSpan}
        className={cn('px-4 py-8 text-center text-body', tone === 'danger' ? 'text-danger' : 'text-muted')}
      >
        {children}
      </td>
    </tr>
  )
}
