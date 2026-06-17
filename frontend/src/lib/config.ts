/** Contract ids — injected at deploy via window globals; fallback to current cids. */
declare global {
  interface Window {
    BOOKING_CID?: number
    MEDIA_CID?: number
  }
}

export const BOOKING_CID: number =
  (typeof window !== 'undefined' && window.BOOKING_CID) || 70476292333823

export const MEDIA_CID: number =
  (typeof window !== 'undefined' && window.MEDIA_CID) || 47590379230541

/** Format integer cents → grouped 2-decimal string. */
export function fmtCents(cents: bigint | number): string {
  const v = typeof cents === 'bigint' ? cents : BigInt(Math.trunc(cents))
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (v % 100n).toString().padStart(2, '0')
  return `${whole}.${frac}`
}

/** A slot start (ns) → "Sat, Apr 5 · 14:30". */
export function slotTime(ns: bigint): string {
  const d = new Date(Number(ns / 1_000_000n))
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
