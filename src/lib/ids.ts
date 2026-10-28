/**
 * Client-generated idempotency keys.
 *
 * Only two commands carry one, per the backend contract: `eventId` on
 * arrival (so a resubmitted registration creates no second visit) and
 * `commandId` on an availability change (so a delayed retry cannot flip it
 * twice). Accept / outcome / departure / attributes have no client key -
 * the backend's own current-state check makes a blind retry safe and
 * reports it back as `replayed`/`duplicate`.
 */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}_${random}`
}

export const newEventId = () => newId('evt')
export const newCommandId = () => newId('cmd')
