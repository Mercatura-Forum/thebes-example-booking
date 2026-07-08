import { useMemo, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import {
  BOOKING_CID, M, decodeListings, decodeSlots, natArg,
  book, joinWaitlist, leaveWaitlist,
  type Listing, type Slot,
} from '../lib/booking-api'
import { fmtCents, fmtDuration } from '../lib/config'
import { fmtClock, fmtDay, fmtSlot, fmtUntil } from '../lib/chainTime'
import { MediaImage } from '../components/MediaImage'
import { ListingArt } from '../components/ListingArt'
import { Price, Button, Spinner, EmptyState, ErrorNote } from '../components/ui'

export function ListingPage() {
  const { id } = useParams()
  const listingId = BigInt(id ?? '0')
  const nav = useNavigate()
  const listings = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  const slots = useQuery<Slot[]>(BOOKING_CID, M.slots, natArg(listingId), decodeSlots, [id])
  const [selected, setSelected] = useState<bigint>()
  const [seats, setSeats] = useState(1)
  const [confirmed, setConfirmed] = useState<{ id: bigint; slot: Slot; seats: number }>()
  const [waitPos, setWaitPos] = useState<{ slot: Slot; pos: bigint }>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  // Reset purchase state when navigating listing → listing (same document).
  const [lastId, setLastId] = useState(id)
  if (id !== lastId) {
    setLastId(id)
    setSelected(undefined)
    setSeats(1)
    setConfirmed(undefined)
    setWaitPos(undefined)
    setErr(undefined)
  }

  const byDay = useMemo(() => {
    const groups = new Map<string, Slot[]>()
    for (const s of slots.data ?? []) {
      const k = fmtDay(s.startNs)
      const g = groups.get(k)
      if (g) g.push(s)
      else groups.set(k, [s])
    }
    return [...groups.entries()]
  }, [slots.data])

  if (listings.loading) return <Spinner label="Loading" />
  if (listings.error) return <ErrorNote message={listings.error} />
  const listing = (listings.data ?? []).find((l) => l.id === listingId)
  if (!listing) return <EmptyState title="Listing not found" hint="It may have been removed." action={<Link to="/"><Button>Back</Button></Link>} />

  const sel = (slots.data ?? []).find((s) => s.id === selected)
  const selFull = sel !== undefined && Number(sel.remaining) === 0
  const maxSeats = sel === undefined ? Number(listing.capacity) : selFull ? Number(sel.capacity) : Number(sel.remaining)
  const deposit = listing.priceCents * BigInt(Math.max(seats, 1))
  const windowMin = Number(listing.cancelWindowMinutes)

  async function reserve() {
    if (!sel) return
    setBusy(true); setErr(undefined)
    try {
      const bid = await book(sel.id, BigInt(seats))
      setConfirmed({ id: bid, slot: sel, seats })
      setSelected(undefined)
      slots.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      slots.refetch() // someone may have just taken it
    } finally {
      setBusy(false)
    }
  }

  async function wait() {
    if (!sel) return
    setBusy(true); setErr(undefined)
    try {
      const pos = await joinWaitlist(sel.id, BigInt(seats))
      setWaitPos({ slot: sel, pos })
      setSelected(undefined)
      slots.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      slots.refetch()
    } finally {
      setBusy(false)
    }
  }

  async function unwait(slotId: bigint) {
    setBusy(true); setErr(undefined)
    try {
      await leaveWaitlist(slotId)
      setWaitPos(undefined)
      slots.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-line)]">
          {listing.photoPath
            ? <MediaImage path={listing.photoPath} alt={listing.name} ratio="4 / 3" />
            : <ListingArt kind={listing.kind} seed={Number(listing.id)} ratio="4 / 3" />}
        </div>
        <div className="card mt-4 p-4 text-sm leading-relaxed text-ink-soft">
          <p>{listing.description}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs nums">
            <p><span className="font-semibold text-ink">{fmtDuration(listing.durationMinutes)}</span> per slot</p>
            <p>up to <span className="font-semibold text-ink">{listing.capacity.toString()}</span> {Number(listing.capacity) === 1 ? 'guest' : 'guests'}</p>
            <p>deposit <span className="font-semibold text-ink">${fmtCents(listing.priceCents)}</span> / seat</p>
            <p>free cancel until <span className="font-semibold text-ink">{windowMin >= 60 ? `${Math.round(windowMin / 60)} h` : `${windowMin} min`}</span> before</p>
          </div>
        </div>
      </div>

      <div>
        <Link to="/" className="text-sm text-[var(--color-teal)] hover:underline">← All listings</Link>
        <h1 className="font-display mt-3 text-3xl font-extrabold">{listing.name}</h1>
        <div className="mt-3 flex items-center gap-3">
          <Price cents={listing.priceCents} />
          <span className="text-sm text-ink-soft nums">per seat · {fmtDuration(listing.durationMinutes)}</span>
        </div>

        {confirmed && (
          <div className="mt-6 card border-[var(--color-teal)]/40 p-5" data-testid="booking-confirmed">
            <p className="font-display text-lg font-bold text-[var(--color-teal-ink)]">Reserved ✓</p>
            <p className="mt-1 text-sm text-ink-soft nums">
              Booking #{confirmed.id.toString()} · {confirmed.seats} seat{confirmed.seats > 1 ? 's' : ''} · {fmtSlot(confirmed.slot.startNs)}.
              Deposit ${fmtCents(listing.priceCents * BigInt(confirmed.seats))} held in escrow —
              cancel free until {windowMin >= 60 ? `${Math.round(windowMin / 60)} h` : `${windowMin} min`} before start.
            </p>
            <Button className="mt-3" onClick={() => nav('/mine')}>View my reservations</Button>
          </div>
        )}
        {waitPos && (
          <div className="mt-6 card border-[var(--color-amber)]/40 p-5" data-testid="waitlist-joined">
            <p className="font-display text-lg font-bold text-[var(--color-amber)]">On the waitlist</p>
            <p className="mt-1 text-sm text-ink-soft nums">
              Position {waitPos.pos.toString()} for {fmtSlot(waitPos.slot.startNs)}. If seats free up you're
              booked automatically, strictly first-come-first-served.
            </p>
            <Button variant="ghost" className="mt-3" disabled={busy} onClick={() => unwait(waitPos.slot.id)}>Leave waitlist</Button>
          </div>
        )}

        <h2 className="mt-6 font-display text-lg font-bold">Pick a time</h2>
        {slots.loading ? (
          <div className="mt-3"><Spinner /></div>
        ) : byDay.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No open times right now — check back soon.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {byDay.map(([day, group]) => (
              <div key={day}>
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-soft">{day}</p>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {group.map((s) => {
                    const full = Number(s.remaining) === 0
                    const isSel = selected === s.id
                    return (
                      <button key={s.id.toString()} className="slot-chip" data-selected={isSel}
                        onClick={() => { setSelected(isSel ? undefined : s.id); setSeats(1); setErr(undefined) }}>
                        <span className="flex items-center justify-between">
                          <span className="text-sm font-semibold nums">{fmtClock(s.startNs)}</span>
                          {Number(s.mySeats) > 0 && <span className="text-[10px] font-bold text-[var(--color-teal-ink)]">YOURS ×{s.mySeats.toString()}</span>}
                          {Number(s.myWaitPos) > 0 && <span className="text-[10px] font-bold text-[var(--color-amber)]">WAIT #{s.myWaitPos.toString()}</span>}
                        </span>
                        <span className="mt-1 flex items-center gap-1" aria-label={full ? 'Full' : `${s.remaining} of ${s.capacity} seats free`}>
                          {Array.from({ length: Math.min(Number(s.capacity), 8) }, (_, i) => (
                            <span key={i} className="seat-dot"
                              style={{ background: i < Number(s.seatsBooked) ? 'var(--color-ink-soft)' : 'var(--color-teal)', opacity: i < Number(s.seatsBooked) ? 0.45 : 1 }} />
                          ))}
                          <span className={`ml-1 text-[10px] font-semibold nums ${full ? 'text-[var(--color-busy)]' : 'text-ink-soft'}`}>
                            {full ? (Number(s.waitlistLen) > 0 ? `full · ${s.waitlistLen.toString()} waiting` : 'full') : `${s.remaining.toString()} free`}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {sel && (
          <div className="card sticky bottom-4 mt-5 p-4 shadow-lg" data-testid="booking-bar">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <p className="font-semibold nums">{fmtSlot(sel.startNs)}</p>
                <p className="text-xs text-ink-soft nums">
                  {selFull
                    ? `Full — join the waitlist (${sel.waitlistLen.toString()} ahead of you)`
                    : <>Deposit ${fmtCents(deposit)} · free cancel {fmtUntil(sel.startNs - listing.cancelWindowMinutes * 60_000_000_000n) ? `for ${fmtUntil(sel.startNs - listing.cancelWindowMinutes * 60_000_000_000n)}` : 'window closed'}</>}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center rounded-xl ring-1 ring-[var(--color-line)]">
                  <button className="px-3 py-1.5 text-sm font-bold" aria-label="Fewer seats" onClick={() => setSeats((s) => Math.max(1, s - 1))}>−</button>
                  <span className="min-w-8 text-center text-sm font-bold nums">{seats}</span>
                  <button className="px-3 py-1.5 text-sm font-bold" aria-label="More seats" onClick={() => setSeats((s) => Math.min(maxSeats, s + 1))}>+</button>
                </div>
                {selFull
                  ? <Button onClick={wait} disabled={busy || Number(sel.myWaitPos) > 0}>{Number(sel.myWaitPos) > 0 ? `Waitlisted #${sel.myWaitPos.toString()}` : busy ? 'Joining…' : 'Join waitlist'}</Button>
                  : <Button onClick={reserve} disabled={busy}>{busy ? 'Reserving…' : `Reserve · $${fmtCents(deposit)}`}</Button>}
              </div>
            </div>
            {err && <div className="mt-3"><ErrorNote message={err} /></div>}
          </div>
        )}
      </div>
    </div>
  )
}
