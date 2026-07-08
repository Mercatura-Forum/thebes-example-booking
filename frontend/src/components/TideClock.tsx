import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BoardSlot } from '../lib/booking-api'
import { wallDate, fmtClock } from '../lib/chainTime'
import { useCalibrated } from '../lib/useCalibrated'

/**
 * TideClock — the harbor's emblem: the coming week of REAL availability as a
 * tide chart. One ring per day (today outermost, day 6 innermost), midnight at
 * the top, time flowing clockwise. Every arc is a live slot from the chain:
 * luminous teal while seats remain (brighter = emptier), sunk ink once full.
 * A hand sweeps the true time of day. Hover any arc for the slot; click to go
 * book it. No assets, no textures — the data is the artwork.
 */

interface Hit {
  slot: BoardSlot
  x: number
  y: number
}

const RINGS = 7
const TAU = Math.PI * 2

export function TideClock({
  board,
  names,
  className = '',
}: {
  board: BoardSlot[]
  names: Map<string, string>
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const nav = useNavigate()
  const [hit, setHit] = useState<Hit | null>(null)
  const hitRef = useRef<Hit | null>(null)

  // Geometry per slot, recomputed when the board changes — and again when the
  // chain-clock calibration lands (day rings are meaningless before it).
  const cal = useCalibrated()
  const arcs = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const t0 = today.getTime()
    return board
      .map((s) => {
        const st = wallDate(s.startNs)
        const en = wallDate(s.endNs)
        const day = Math.floor((st.getTime() - t0) / 86_400_000)
        if (day < 0 || day >= RINGS) return null
        const a0 = -Math.PI / 2 + (dayFrac(st) * TAU)
        // Clamp the visual arc to its own day so nothing wraps over midnight.
        const endFrac = Math.min(dayFrac(en) <= dayFrac(st) ? 1 : dayFrac(en), 1)
        const a1 = -Math.PI / 2 + endFrac * TAU
        return { slot: s, day, a0, a1 }
      })
      .filter((a): a is { slot: BoardSlot; day: number; a0: number; a1: number } => a !== null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, cal])

  useEffect(() => {
    const el = host.current
    const cv = canvas.current
    if (!el || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dark = () => document.documentElement.classList.contains('dark')
    let raf = 0
    let running = true
    let visible = true
    let W = 0
    let H = 0

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
    })
    io.observe(el)

    function resize() {
      if (!el || !cv || !ctx) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = el.clientWidth
      H = el.clientHeight
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      cv.style.width = `${W}px`
      cv.style.height = `${H}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    function draw(tMs: number) {
      if (!ctx) return
      const cx = W / 2
      const cy = H / 2
      const rMax = Math.min(W, H) / 2 - 34
      const step = rMax / (RINGS + 0.6)
      const isDark = dark()
      const ink = isDark ? 'rgba(220,236,233,' : 'rgba(12,47,44,'
      const teal = isDark ? '64,212,199' : '15,138,130'
      const breathe = reduced ? 1 : 0.88 + 0.12 * Math.sin(tMs / 1600)

      ctx.clearRect(0, 0, W, H)

      // Day rings — faint water lines.
      for (let d = 0; d < RINGS; d++) {
        const r = rMax - d * step
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, TAU)
        ctx.strokeStyle = ink + (d === 0 ? '0.16)' : '0.08)')
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // Hour ticks + the four cardinal hour labels.
      ctx.font = '600 10px Sora Variable, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let h = 0; h < 24; h++) {
        const a = -Math.PI / 2 + (h / 24) * TAU
        const long = h % 6 === 0
        const r0 = rMax + (long ? 6 : 3)
        const r1 = rMax + (long ? 12 : 7)
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
        ctx.strokeStyle = ink + (long ? '0.35)' : '0.15)')
        ctx.lineWidth = long ? 1.5 : 1
        ctx.stroke()
        if (long) {
          ctx.fillStyle = ink + '0.55)'
          ctx.fillText(`${h.toString().padStart(2, '0')}`, cx + Math.cos(a) * (rMax + 22), cy + Math.sin(a) * (rMax + 22))
        }
      }

      // The slots — the tide itself.
      const active = hitRef.current
      for (const arc of arcs) {
        const r = rMax - arc.day * step
        const free = Number(arc.slot.remaining)
        const cap = Math.max(Number(arc.slot.capacity), 1)
        const isHit = active !== null && active.slot.id === arc.slot.id
        ctx.beginPath()
        ctx.arc(cx, cy, r, arc.a0, Math.max(arc.a1, arc.a0 + 0.035))
        ctx.lineCap = 'round'
        if (free > 0) {
          const depth = 0.45 + 0.55 * (free / cap)
          ctx.strokeStyle = `rgba(${teal},${(0.38 + 0.5 * depth) * breathe})`
          ctx.lineWidth = isHit ? step * 0.72 : step * 0.5
          ctx.shadowColor = `rgba(${teal},0.55)`
          ctx.shadowBlur = isHit ? 16 : 9 * breathe
        } else {
          ctx.strokeStyle = ink + (isHit ? '0.6)' : '0.32)')
          ctx.lineWidth = isHit ? step * 0.5 : step * 0.32
          ctx.shadowBlur = 0
        }
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // The now hand — true time of day, sweeping.
      const now = new Date()
      const na = -Math.PI / 2 + dayFrac(now) * TAU
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(na) * (rMax - RINGS * step + step * 0.2), cy + Math.sin(na) * (rMax - RINGS * step + step * 0.2))
      ctx.lineTo(cx + Math.cos(na) * (rMax + 4), cy + Math.sin(na) * (rMax + 4))
      ctx.strokeStyle = isDark ? 'rgba(255,196,87,0.85)' : 'rgba(180,83,9,0.75)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx + Math.cos(na) * rMax, cy + Math.sin(na) * rMax, 3.4, 0, TAU)
      ctx.fillStyle = isDark ? '#ffc457' : '#b45309'
      ctx.fill()

      // Center: today's free-seat count — the number the whole page is about.
      const freeToday = arcs.filter((a) => a.day === 0).reduce((n, a) => n + Number(a.slot.remaining), 0)
      ctx.fillStyle = ink + '0.9)'
      ctx.font = '700 26px Sora Variable, sans-serif'
      ctx.fillText(String(freeToday), cx, cy - 8)
      ctx.fillStyle = ink + '0.5)'
      ctx.font = '600 9.5px Sora Variable, sans-serif'
      ctx.fillText('SEATS FREE TODAY', cx, cy + 13)
    }

    function loop(t: number) {
      if (!running) return
      if (visible && !document.hidden) draw(t)
      raf = requestAnimationFrame(loop)
    }
    if (reduced) {
      draw(0)
    } else {
      raf = requestAnimationFrame(loop)
    }

    // Hit-testing: polar lookup against the arc table.
    function locate(ev: MouseEvent): Hit | null {
      if (!cv) return null
      const rect = cv.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      const cx = W / 2
      const cy = H / 2
      const rMax = Math.min(W, H) / 2 - 34
      const step = rMax / (RINGS + 0.6)
      const dx = x - cx
      const dy = y - cy
      const r = Math.hypot(dx, dy)
      let a = Math.atan2(dy, dx)
      for (const arc of arcs) {
        const rr = rMax - arc.day * step
        if (Math.abs(r - rr) > step * 0.45) continue
        // Normalize the angle into the arc's frame.
        let rel = a
        while (rel < arc.a0) rel += TAU
        if (rel <= arc.a1 + 0.02) return { slot: arc.slot, x, y }
      }
      return null
    }
    function onMove(ev: MouseEvent) {
      const h = locate(ev)
      hitRef.current = h
      setHit(h)
      if (cv) cv.style.cursor = h ? 'pointer' : 'default'
      if (reduced) draw(0)
    }
    function onLeave() {
      hitRef.current = null
      setHit(null)
      if (reduced) draw(0)
    }
    function onClick(ev: MouseEvent) {
      const h = locate(ev)
      if (h) nav(`/l/${h.slot.listingId}`)
    }
    cv.addEventListener('mousemove', onMove)
    cv.addEventListener('mouseleave', onLeave)
    cv.addEventListener('click', onClick)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      cv.removeEventListener('mousemove', onMove)
      cv.removeEventListener('mouseleave', onLeave)
      cv.removeEventListener('click', onClick)
    }
  }, [arcs, nav])

  return (
    <div ref={host} className={`relative ${className}`} role="img"
      aria-label="Tide clock: this week's live availability by day and hour. Teal arcs are open slots; dark arcs are full.">
      <canvas ref={canvas} />
      {hit && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-[var(--color-line)] bg-surface px-3 py-1.5 text-xs shadow-lg"
          style={{ left: hit.x, top: hit.y - 44 }}
        >
          <span className="font-semibold">{names.get(hit.slot.listingId.toString()) ?? 'Listing'}</span>
          <span className="text-ink-soft"> · {fmtClock(hit.slot.startNs)} · </span>
          {Number(hit.slot.remaining) > 0
            ? <span className="text-[var(--color-teal-ink)] font-semibold">{hit.slot.remaining.toString()} of {hit.slot.capacity.toString()} free</span>
            : <span className="text-[var(--color-busy)] font-semibold">full</span>}
        </div>
      )}
    </div>
  )
}

function dayFrac(d: Date): number {
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86_400
}
