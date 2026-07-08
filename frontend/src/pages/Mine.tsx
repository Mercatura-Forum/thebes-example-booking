import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import {
  BOOKING_CID, M, decodeReservations, decodeWaitlist,
  cancelBooking, leaveWaitlist,
  type Reservation, type WaitlistEntry,
} from '../lib/booking-api'
import { fmtCents } from '../lib/config'
import { chainNowNs, fmtSlot, fmtUntil } from '../lib/chainTime'
import { Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

function StatusChip({ status, promoted }: { status: string; promoted: boolean }) {
  return (
    <span className={`status-chip status-${status.replace(' ', '-')}`}>
      {status}{promoted && status === 'confirmed' ? ' · from waitlist' : ''}
    </span>
  )
}

export function Mine() {
  const mine = useQuery<Reservation[]>(BOOKING_CID, M.mine, undefined, decodeReservations)
  const waits = useQuery<WaitlistEntry[]>(BOOKING_CID, M.myWaitlist, undefined, decodeWaitlist)
  const [busy, setBusy] = useState<bigint>()
  const [note, setNote] = useState<string>()
  const [err, setErr] = useState<string>()

  if (mine.loading) return <Spinner label="Loading your reservations" />
  if (mine.error) return <ErrorNote message={mine.error} />

  const rows = mine.data ?? []
  const waitRows = waits.data ?? []
  const now = chainNowNs()
  const upcoming = rows.filter((r) => (r.status === 'confirmed' || r.status === 'checked-in') && r.startNs > now)
  const past = rows.filter((r) => !upcoming.includes(r))

  if (rows.length === 0 && waitRows.length === 0) {
    return <EmptyState title="No reservations yet" hint="Browse the harbor and pick a time — your bookings and waitlists appear here." action={<Link to="/"><Button>Browse</Button></Link>} />
  }

  async function cancel(r: Reservation) {
    const freeCancel = now <= r.cancelDeadlineNs
    if (!freeCancel && !window.confirm(`The free-cancellation window has closed — cancelling now forfeits your $${fmtCents(r.depositCents)} deposit. Cancel anyway?`)) return
    setBusy(r.id); setErr(undefined); setNote(undefined)
    try {
      const outcome = await cancelBooking(r.id)
      setNote(outcome === 'refunded'
        ? `Cancelled — your $${fmtCents(r.depositCents)} deposit was refunded in full.`
        : `Cancelled — the $${fmtCents(r.depositCents)} deposit was forfeited (inside the window).`)
      mine.refetch()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(undefined) }
  }

  async function unwait(w: WaitlistEntry) {
    setBusy(w.slotId); setErr(undefined); setNote(undefined)
    try {
      await leaveWaitlist(w.slotId)
      setNote('Left the waitlist.')
      waits.refetch()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(undefined) }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-bold">My reservations</h1>
      {note && <p className="mt-3 rounded-lg bg-[var(--color-teal)]/10 px-3 py-2 text-sm text-[var(--color-teal-ink)]">{note}</p>}
      {err && <div className="mt-3"><ErrorNote message={err} /></div>}

      {upcoming.length > 0 && (
        <ul className="mt-5 space-y-3">
          {upcoming.map((r) => {
            const freeFor = fmtUntil(r.cancelDeadlineNs)
            return (
              <li key={r.id.toString()} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-display font-semibold">{r.listingName}</p>
                    <p className="text-sm text-ink-soft nums">
                      {fmtSlot(r.startNs)} · {r.seats.toString()} seat{Number(r.seats) > 1 ? 's' : ''} · ${fmtCents(r.depositCents)} in escrow
                    </p>
                  </div>
                  <StatusChip status={r.status} promoted={Number(r.promoted) === 1} />
                </div>
                {r.status === 'confirmed' && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] pt-3">
                    <p className="text-xs text-ink-soft nums">
                      {freeFor
                        ? <>Free cancellation for <span className="font-semibold text-[var(--color-teal-ink)]">{freeFor}</span></>
                        : <span className="text-[var(--color-amber)] font-semibold">Cancelling now forfeits the deposit</span>}
                    </p>
                    <Button variant="ghost" disabled={busy === r.id} onClick={() => cancel(r)}>
                      {busy === r.id ? 'Cancelling…' : 'Cancel booking'}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {waitRows.length > 0 && (
        <>
          <h2 className="mt-8 font-display text-lg font-bold">Waitlists</h2>
          <ul className="mt-3 space-y-3">
            {waitRows.map((w) => (
              <li key={w.slotId.toString()} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-display font-semibold">{w.listingName}</p>
                  <p className="text-sm text-ink-soft nums">
                    {fmtSlot(w.startNs)} · {w.seats.toString()} seat{Number(w.seats) > 1 ? 's' : ''} ·
                    position <span className="font-semibold text-[var(--color-amber)]">#{w.position.toString()}</span> — booked automatically when seats free up
                  </p>
                </div>
                <Button variant="ghost" disabled={busy === w.slotId} onClick={() => unwait(w)}>Leave</Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2 className="mt-8 font-display text-lg font-bold">History</h2>
          <ul className="mt-3 space-y-2">
            {past.map((r) => (
              <li key={r.id.toString()} className="card flex items-center justify-between gap-4 p-3 opacity-80">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{r.listingName}</p>
                  <p className="text-xs text-ink-soft nums">{fmtSlot(r.startNs)} · ${fmtCents(r.depositCents)}</p>
                </div>
                <StatusChip status={r.status} promoted={Number(r.promoted) === 1} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
