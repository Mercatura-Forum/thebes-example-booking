/**
 * booking-api.ts — typed reads/writes for the Harbor reservation engine.
 * A "listing" is any reservable thing (boat, car, studio, court). Reads use
 * flat `*View` methods; writes use the trap-wrappers so a rejected guard
 * surfaces as a thrown reason (e.g. "Only 2 seat(s) left on this slot").
 */
import { query, update, encodeArg, encodeArgs, decodeVecRecord, decodeNat } from '@thebes/sdk'
import { BOOKING_CID } from './config'
import { calibrate } from './chainTime'

// ── Row shapes (mirror the backend view records; flags are nat 0/1) ──

export interface Listing {
  id: bigint
  name: string
  description: string
  kind: string
  durationMinutes: bigint
  priceCents: bigint
  capacity: bigint
  cancelWindowMinutes: bigint
  photoPath: string
  archived: bigint
  slotsFree: bigint
  slotsTotal: bigint
  nextFreeNs: bigint
  utilizationBps: bigint
}

export interface Slot {
  id: bigint
  listingId: bigint
  startNs: bigint
  endNs: bigint
  capacity: bigint
  seatsBooked: bigint
  remaining: bigint
  waitlistLen: bigint
  mySeats: bigint
  myWaitPos: bigint
}

export interface BoardSlot {
  id: bigint
  listingId: bigint
  kind: string
  startNs: bigint
  endNs: bigint
  capacity: bigint
  remaining: bigint
}

export interface Reservation {
  id: bigint
  listingId: bigint
  listingName: string
  kind: string
  startNs: bigint
  endNs: bigint
  seats: bigint
  depositCents: bigint
  status: string
  cancelDeadlineNs: bigint
  promoted: bigint
  nowNs: bigint
}

export interface WaitlistEntry {
  slotId: bigint
  listingId: bigint
  listingName: string
  startNs: bigint
  seats: bigint
  position: bigint
  nowNs: bigint
}

export interface AgendaRow {
  bookingId: bigint
  listingId: bigint
  listingName: string
  customer: string
  seats: bigint
  depositCents: bigint
  startNs: bigint
  endNs: bigint
  status: string
  promoted: bigint
}

export interface Conservation {
  ok: bigint
  collectedCents: bigint
  heldCents: bigint
  refundedCents: bigint
  forfeitedCents: bigint
  capturedCents: bigint
  violations: bigint
}

export interface Violation {
  rule: string
  detail: string
}

export interface Stats {
  listings: bigint
  slotsOpen: bigint
  slotsClosed: bigint
  bookingsTotal: bigint
  confirmed: bigint
  checkedIn: bigint
  completed: bigint
  cancelled: bigint
  noShows: bigint
  waitlistEntries: bigint
  auditEvents: bigint
  futureSeatsBooked: bigint
  futureSeatsCapacity: bigint
}

export interface AuditEvent {
  seq: bigint
  at: bigint
  who: string
  kind: string
  refA: bigint
  refB: bigint
  note: string
}

// ── Field tables ──

type F = { name: string; type: 'nat' | 'int' | 'bool' | 'text' | 'principal' }
const nat = (name: string): F => ({ name, type: 'nat' })
const int = (name: string): F => ({ name, type: 'int' })
const text = (name: string): F => ({ name, type: 'text' })
const principal = (name: string): F => ({ name, type: 'principal' })

const LISTING_FIELDS: F[] = [
  nat('id'), text('name'), text('description'), text('kind'), nat('durationMinutes'),
  nat('priceCents'), nat('capacity'), nat('cancelWindowMinutes'), text('photoPath'),
  nat('archived'), nat('slotsFree'), nat('slotsTotal'), int('nextFreeNs'), nat('utilizationBps'),
]
const SLOT_FIELDS: F[] = [
  nat('id'), nat('listingId'), int('startNs'), int('endNs'), nat('capacity'),
  nat('seatsBooked'), nat('remaining'), nat('waitlistLen'), nat('mySeats'), nat('myWaitPos'),
]
const BOARD_FIELDS: F[] = [
  nat('id'), nat('listingId'), text('kind'), int('startNs'), int('endNs'), nat('capacity'), nat('remaining'),
]
const RES_FIELDS: F[] = [
  nat('id'), nat('listingId'), text('listingName'), text('kind'), int('startNs'), int('endNs'),
  nat('seats'), nat('depositCents'), text('status'), int('cancelDeadlineNs'), nat('promoted'), int('nowNs'),
]
const WAIT_FIELDS: F[] = [
  nat('slotId'), nat('listingId'), text('listingName'), int('startNs'), nat('seats'), nat('position'), int('nowNs'),
]
const AGENDA_FIELDS: F[] = [
  nat('bookingId'), nat('listingId'), text('listingName'), principal('customer'), nat('seats'),
  nat('depositCents'), int('startNs'), int('endNs'), text('status'), nat('promoted'),
]
const CONSERVATION_FIELDS: F[] = [
  nat('ok'), nat('collectedCents'), nat('heldCents'), nat('refundedCents'),
  nat('forfeitedCents'), nat('capturedCents'), nat('violations'),
]
const VIOLATION_FIELDS: F[] = [text('rule'), text('detail')]
const STATS_FIELDS: F[] = [
  nat('listings'), nat('slotsOpen'), nat('slotsClosed'), nat('bookingsTotal'), nat('confirmed'),
  nat('checkedIn'), nat('completed'), nat('cancelled'), nat('noShows'), nat('waitlistEntries'),
  nat('auditEvents'), nat('futureSeatsBooked'), nat('futureSeatsCapacity'),
]
const AUDIT_FIELDS: F[] = [
  nat('seq'), int('at'), principal('who'), text('kind'), nat('refA'), nat('refB'), text('note'),
]
const TIME_FIELDS: F[] = [int('nowNs')]
const OUTCOME_FIELDS: F[] = [text('outcome')]

// ── Decoders (calibrate the chain clock whenever a view carries nowNs) ──

export const decodeListings = (h: string) => decodeVecRecord(h, LISTING_FIELDS) as unknown as Listing[]
export const decodeSlots = (h: string) => decodeVecRecord(h, SLOT_FIELDS) as unknown as Slot[]
export const decodeBoard = (h: string) => decodeVecRecord(h, BOARD_FIELDS) as unknown as BoardSlot[]
export const decodeReservations = (h: string) => {
  const rows = decodeVecRecord(h, RES_FIELDS) as unknown as Reservation[]
  if (rows.length > 0) calibrate(rows[0].nowNs)
  return rows
}
export const decodeWaitlist = (h: string) => {
  const rows = decodeVecRecord(h, WAIT_FIELDS) as unknown as WaitlistEntry[]
  if (rows.length > 0) calibrate(rows[0].nowNs)
  return rows
}
export const decodeAgenda = (h: string) => decodeVecRecord(h, AGENDA_FIELDS) as unknown as AgendaRow[]
export const decodeConservation = (h: string) => (decodeVecRecord(h, CONSERVATION_FIELDS) as unknown as Conservation[])[0]
export const decodeViolations = (h: string) => decodeVecRecord(h, VIOLATION_FIELDS) as unknown as Violation[]
export const decodeStats = (h: string) => (decodeVecRecord(h, STATS_FIELDS) as unknown as Stats[])[0]
export const decodeAudit = (h: string) => decodeVecRecord(h, AUDIT_FIELDS) as unknown as AuditEvent[]

export const M = {
  listings: 'listingsView',
  slots: 'slotsView',
  board: 'boardView',
  mine: 'myBookingsView',
  myWaitlist: 'myWaitlistView',
  agenda: 'agendaView',
  conservation: 'conservationView',
  invariants: 'invariantReportView',
  stats: 'statsView',
  audit: 'auditView',
} as const

export const natArg = (v: bigint) => encodeArgs([{ type: 'nat', value: v }])
export const rangeArgs = (fromNs: bigint, toNs: bigint) =>
  encodeArgs([{ type: 'int', value: fromNs }, { type: 'int', value: toNs }])

/** One-shot chain-clock calibration (fired once from Layout on mount). */
export async function calibrateChainClock(): Promise<void> {
  const r = await query(BOOKING_CID, 'timeView')
  const rows = decodeVecRecord(r.reply_hex ?? r.reply ?? '', TIME_FIELDS) as unknown as { nowNs: bigint }[]
  if (rows.length > 0) calibrate(rows[0].nowNs)
}

// ── Writes (trap-wrappers → clean value or thrown reason) ──

async function callNat(method: string, argHex: string): Promise<bigint> {
  const r = await update(BOOKING_CID, method, argHex)
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
async function callVoid(method: string, argHex: string): Promise<void> {
  await update(BOOKING_CID, method, argHex)
}

/** Book seats on a slot → booking id, or throws (e.g. "Only 2 seat(s) left on this slot"). */
export const book = (slotId: bigint, seats: bigint) =>
  callNat('bookOrTrap', encodeArgs([{ type: 'nat', value: slotId }, { type: 'nat', value: seats }]))

/** Cancel own booking → "refunded" | "forfeited", or throws. */
export async function cancelBooking(bookingId: bigint): Promise<string> {
  const r = await update(BOOKING_CID, 'cancelBookingOrTrap', encodeArg({ type: 'nat', value: bookingId }))
  const rows = decodeVecRecord(r.reply_hex ?? r.reply ?? '', OUTCOME_FIELDS) as unknown as { outcome: string }[]
  return rows.length > 0 ? rows[0].outcome : 'cancelled'
}

/** Join a full slot's waitlist → 1-based position, or throws. */
export const joinWaitlist = (slotId: bigint, seats: bigint) =>
  callNat('joinWaitlistOrTrap', encodeArgs([{ type: 'nat', value: slotId }, { type: 'nat', value: seats }]))

export const leaveWaitlist = (slotId: bigint) =>
  callVoid('leaveWaitlistOrTrap', encodeArg({ type: 'nat', value: slotId }))

export async function claimOwner(): Promise<void> {
  await update(BOOKING_CID, 'claimOwner')
}

export const addListing = (
  name: string, description: string, kind: string, durationMinutes: number,
  priceCents: bigint, capacity: number, cancelWindowMinutes: number, photoPath: string | null,
) =>
  callNat('addListingOrTrap', encodeArgs([
    { type: 'text', value: name },
    { type: 'text', value: description },
    { type: 'text', value: kind },
    { type: 'nat', value: BigInt(durationMinutes) },
    { type: 'nat', value: priceCents },
    { type: 'nat', value: BigInt(capacity) },
    { type: 'nat', value: BigInt(cancelWindowMinutes) },
    { type: 'opt', inner: { type: 'text' }, value: photoPath },
  ]))

export const updateListing = (
  id: bigint, name: string, description: string, kind: string, priceCents: bigint, cancelWindowMinutes: number,
) =>
  callVoid('updateListingOrTrap', encodeArgs([
    { type: 'nat', value: id },
    { type: 'text', value: name },
    { type: 'text', value: description },
    { type: 'text', value: kind },
    { type: 'nat', value: priceCents },
    { type: 'nat', value: BigInt(cancelWindowMinutes) },
  ]))

export const archiveListing = (id: bigint, archived: boolean) =>
  callVoid('archiveListingOrTrap', encodeArgs([{ type: 'nat', value: id }, { type: 'bool', value: archived }]))

export const setListingPhoto = (id: bigint, photoPath: string) =>
  callVoid('setListingPhotoOrTrap', encodeArgs([{ type: 'nat', value: id }, { type: 'text', value: photoPath }]))

/** Publish a batch of slots → count created, or throws (e.g. the overlap guard). */
export const publishSlots = (listingId: bigint, startNs: bigint, endNs: bigint, intervalMinutes: number, capacity: number) =>
  callNat('publishSlotsOrTrap', encodeArgs([
    { type: 'nat', value: listingId },
    { type: 'int', value: startNs },
    { type: 'int', value: endNs },
    { type: 'nat', value: BigInt(intervalMinutes) },
    { type: 'nat', value: BigInt(capacity) },
  ]))

/** House-cancel a slot (refunds every active booking) → count refunded. */
export const closeSlot = (slotId: bigint) =>
  callNat('closeSlotOrTrap', encodeArg({ type: 'nat', value: slotId }))

export const checkIn = (bookingId: bigint) =>
  callVoid('checkInOrTrap', encodeArg({ type: 'nat', value: bookingId }))
export const markNoShow = (bookingId: bigint) =>
  callVoid('markNoShowOrTrap', encodeArg({ type: 'nat', value: bookingId }))
export const complete = (bookingId: bigint) =>
  callVoid('completeOrTrap', encodeArg({ type: 'nat', value: bookingId }))

/** Seed demo listings + slots + a few live bookings on a fresh contract. */
export async function seedDemo(): Promise<void> {
  await update(BOOKING_CID, 'seedDemo')
}

export { query, BOOKING_CID }
