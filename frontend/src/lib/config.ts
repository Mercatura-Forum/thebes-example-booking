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

/** Minutes → compact human duration: "45 min", "1½ h", "2 h", "3 h 15 min". */
export function fmtDuration(minutes: bigint | number): string {
  const m = Number(minutes)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (rem === 0) return `${h} h`
  if (rem === 30) return `${h}½ h`
  return `${h} h ${rem} min`
}
