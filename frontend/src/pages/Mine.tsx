import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { BOOKING_CID, M, decodeReservations, type Reservation } from '../lib/booking-api'
import { slotTime } from '../lib/config'
import { Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

export function Mine() {
  const { data, loading, error } = useQuery<Reservation[]>(BOOKING_CID, M.mine, undefined, decodeReservations)
  if (loading) return <Spinner label="Loading your reservations" />
  if (error) return <ErrorNote message={error} />
  const mine = data ?? []
  if (mine.length === 0) {
    return <EmptyState title="No upcoming reservations" hint="Browse listings and reserve a time." action={<Link to="/"><Button>Browse</Button></Link>} />
  }
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-bold">My reservations</h1>
      <ul className="mt-5 space-y-3">
        {mine.map((r) => (
          <li key={r.id.toString()} className="card flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-display font-semibold">{r.serviceName}</p>
              <p className="text-sm text-ink-soft nums">{slotTime(r.slotStart)}</p>
            </div>
            <span className="rounded-full bg-[var(--color-teal)]/10 px-3 py-1 text-xs font-semibold text-[var(--color-teal-ink)]">Confirmed</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
