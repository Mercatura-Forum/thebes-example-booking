/**
 * chainTime.ts — the chain's clock counts nanoseconds since GENESIS, not the
 * Unix epoch. Rendering a chain timestamp with `new Date(ns/1e6)` puts every
 * booking in 1970. Instead we calibrate once: any view that carries `nowNs`
 * (or the `timeView` query) tells us what the chain clock reads *right now*,
 * so `offsetMs = Date.now() − chainNowMs` converts both ways thereafter.
 */

let offsetMs: number | null = null
const listeners = new Set<() => void>()

/** Feed a fresh chain-now (ns) into the calibration. Cheap — call it whenever a view carries one. */
export function calibrate(chainNowNs: bigint): void {
  const first = offsetMs === null
  offsetMs = Date.now() - Number(chainNowNs / 1_000_000n)
  if (first) for (const fn of listeners) fn()
}

/** Re-render subscribers the moment the first calibration lands (it's async —
 * anything that converts wall↔chain time on mount must wait for it). */
export function onCalibrated(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function isCalibrated(): boolean {
  return offsetMs !== null
}

/** Chain ns → wall-clock Date. Falls back to raw interpretation if never calibrated. */
export function wallDate(chainNs: bigint): Date {
  return new Date(Number(chainNs / 1_000_000n) + (offsetMs ?? 0))
}

/** Wall-clock ms → chain ns (for admin inputs like "publish slots from 9am"). */
export function toChainNs(wallMs: number): bigint {
  return BigInt(Math.round(wallMs - (offsetMs ?? 0))) * 1_000_000n
}

/** What the chain clock reads right now (ns), per calibration. */
export function chainNowNs(): bigint {
  return BigInt(Date.now() - (offsetMs ?? 0)) * 1_000_000n
}

/** A chain timestamp → "Sat, Apr 5 · 14:30". */
export function fmtSlot(chainNs: bigint): string {
  const d = wallDate(chainNs)
  return (
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  )
}

/** A chain timestamp → "14:30". */
export function fmtClock(chainNs: bigint): string {
  return wallDate(chainNs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Day heading for slot groups: "Today", "Tomorrow", or "Thu, Jul 9". */
export function fmtDay(chainNs: bigint): string {
  const d = wallDate(chainNs)
  const today = new Date()
  const dayDiff = Math.floor((startOfDay(d) - startOfDay(today)) / 86_400_000)
  if (dayDiff === 0) return 'Today'
  if (dayDiff === 1) return 'Tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function startOfDay(d: Date): number {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c.getTime()
}

/** Positive countdown text to a chain deadline: "2 d 4 h", "3 h 20 m", "12 m". Null once passed. */
export function fmtUntil(chainNs: bigint): string | null {
  const ms = wallDate(chainNs).getTime() - Date.now()
  if (ms <= 0) return null
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${Math.max(m, 1)} m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${m % 60} m`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}
