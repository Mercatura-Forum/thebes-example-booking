import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { BOOKING_CID, M, decodeListings, seedDemo, type Listing } from '../lib/booking-api'
import { MediaImage } from '../components/MediaImage'
import { Price, Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

export function Browse() {
  const { data, loading, error, refetch } = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  const [seeding, setSeeding] = useState(false)
  const [seedErr, setSeedErr] = useState<string>()

  async function seed() {
    setSeeding(true); setSeedErr(undefined)
    try { await seedDemo(); refetch() }
    catch (e) { setSeedErr(e instanceof Error ? e.message : String(e)) }
    finally { setSeeding(false) }
  }

  if (loading) return <Spinner label="Loading listings" />
  if (error) return <ErrorNote message={error} />
  const listings = data ?? []
  if (listings.length === 0) {
    return (
      <div>
        <EmptyState
          title="Nothing to reserve yet"
          hint="Load demo listings to see it live, or add your own — a boat, a car, a studio — in Admin."
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button onClick={seed} disabled={seeding}>{seeding ? 'Loading…' : 'Load demo data'}</Button>
              <Link to="/admin"><Button variant="ghost">Go to Admin</Button></Link>
            </div>
          }
        />
        {seedErr && <div className="mx-auto mt-4 max-w-md"><ErrorNote message={seedErr} /></div>}
      </div>
    )
  }
  return (
    <div>
      <h1 className="font-display text-3xl font-extrabold">Reserve anything</h1>
      <p className="mt-1 text-ink-soft">A boat, a car, a studio, an appointment — booked on-chain, no double-bookings.</p>
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {listings.map((l) => (
          <Link key={l.id.toString()} to={`/l/${l.id}`} className="card overflow-hidden transition hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-16px_rgba(12,47,44,0.35)]">
            <MediaImage path={l.photoPath} alt={l.name} ratio="3 / 2" />
            <div className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-display font-bold leading-tight line-clamp-1">{l.name}</p>
                <p className="mt-0.5 text-xs text-ink-soft nums">{l.durationMinutes.toString()} min</p>
              </div>
              <Price cents={l.priceCents} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
