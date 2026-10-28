/**
 * Client-generated idempotency keys.
 *
 * `eventId` identifies an intentional visitor registration; `commandId`
 * identifies one intended mutation. A retry reuses the original id so the
 * server can reject the replay instead of applying it twice.
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
