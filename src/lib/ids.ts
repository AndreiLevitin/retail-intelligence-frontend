/**
 * Client-generated idempotency keys.
 *
 * Only two commands carry one, per the backend contract: `eventId` on
 * arrival (so a resubmitted registration creates no second visit) and
 * `commandId` on an availability change (so a delayed retry cannot flip it
 * twice). Accept / outcome / departure / attributes have no client key -
 * the backend's own current-state check makes a blind retry safe and
 * reports it back as `replayed`/`duplicate`.
 *
 * The backend validates both as a bare UUID string (see
 * `retail-intelligence-backend/docs/API.md`) - no prefix, no other shape.
 */
function randomUuidV4(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()

  // Fallback for environments without crypto.randomUUID: a real (if not
  // cryptographically strong) UUID v4, still accepted by the backend's
  // format check.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

export const newEventId = randomUuidV4
export const newCommandId = randomUuidV4
