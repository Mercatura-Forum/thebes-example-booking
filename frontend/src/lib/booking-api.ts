/**
 * booking-api.ts — typed reads/writes for the reservations backend. A "service"
 * is any reservable LISTING (boat, car, studio, appointment). Reads use flat
 * `*View` methods; booking uses the trap-wrapper for a clean success/error.
 */
import { query, update, encodeArg, encodeArgs, decodeVecRecord, decodeNat } from '@thebes/sdk'
import { BOOKING_CID } from './config'

export interface Listing {
  id: bigint
  name: string
  durationMinutes: bigint
  priceCents: bigint
  photoPath: string
}
export interface Slot {
  id: bigint
  serviceId: bigint
  startNs: bigint
}
export interface Reservation {
  id: bigint
  serviceId: bigint
  serviceName: string
  slotStart: bigint
}

const LISTING_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'name', type: 'text' as const },
  { name: 'durationMinutes', type: 'nat' as const },
  { name: 'priceCents', type: 'nat' as const },
  { name: 'photoPath', type: 'text' as const },
]
const SLOT_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'serviceId', type: 'nat' as const },
  { name: 'startNs', type: 'int' as const },
]
const RES_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'serviceId', type: 'nat' as const },
  { name: 'serviceName', type: 'text' as const },
  { name: 'slotStart', type: 'int' as const },
]

export const decodeListings = (h: string) => decodeVecRecord(h, LISTING_FIELDS) as unknown as Listing[]
export const decodeSlots = (h: string) => decodeVecRecord(h, SLOT_FIELDS) as unknown as Slot[]
export const decodeReservations = (h: string) => decodeVecRecord(h, RES_FIELDS) as unknown as Reservation[]

export const M = {
  listings: 'servicesView',
  slots: 'availableSlotsView',
  mine: 'myBookingsView',
} as const

export const slotsArgs = (serviceId: bigint) => encodeArgs([{ type: 'nat', value: serviceId }])

// ── Writes ──
/** Book a slot → returns the booking id, or throws with the reason (e.g. "Slot already booked"). */
export async function book(slotId: bigint): Promise<bigint> {
  const r = await update(BOOKING_CID, 'bookAppointmentOrTrap', encodeArg({ type: 'nat', value: slotId }))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
export async function claimOwner(): Promise<void> {
  await update(BOOKING_CID, 'claimOwner')
}
/** Admin: add a listing → returns the listing id, or throws "Not authorized" etc. */
export async function addListing(name: string, durationMinutes: number, priceCents: bigint, photoPath: string | null): Promise<bigint> {
  const r = await update(BOOKING_CID, 'addServiceOrTrap', encodeArgs([
    { type: 'text', value: name },
    { type: 'nat', value: BigInt(durationMinutes) },
    { type: 'nat', value: priceCents },
    { type: 'opt', inner: { type: 'text' }, value: photoPath },
  ]))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
export async function setListingPhoto(serviceId: bigint, photoPath: string): Promise<void> {
  await update(BOOKING_CID, 'setServicePhotoOrTrap', encodeArgs([
    { type: 'nat', value: serviceId },
    { type: 'text', value: photoPath },
  ]))
}
/** Admin: generate slots → returns the count created, or throws (e.g. "Not authorized"). */
export async function createSlots(serviceId: bigint, startNs: bigint, endNs: bigint, intervalMinutes: number): Promise<bigint> {
  const r = await update(BOOKING_CID, 'createSlotsOrTrap', encodeArgs([
    { type: 'nat', value: serviceId },
    { type: 'int', value: startNs },
    { type: 'int', value: endNs },
    { type: 'nat', value: BigInt(intervalMinutes) },
  ]))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}

/** Seed demo listings + slots on a fresh contract (no-op if listings already exist). */
export async function seedDemo(): Promise<void> {
  await update(BOOKING_CID, 'seedDemo')
}

export { query, BOOKING_CID }
