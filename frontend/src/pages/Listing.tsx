import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { BOOKING_CID, M, decodeListings, decodeSlots, slotsArgs, book, type Listing, type Slot } from '../lib/booking-api'
import { slotTime } from '../lib/config'
import { MediaImage } from '../components/MediaImage'
import { Price, Button, Spinner, EmptyState, ErrorNote } from '../components/ui'

export function ListingPage() {
  const { id } = useParams()
  const listingId = BigInt(id ?? '0')
  const nav = useNavigate()
  const listings = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  const slots = useQuery<Slot[]>(BOOKING_CID, M.slots, slotsArgs(listingId), decodeSlots, [id])
  const [booking, setBooking] = useState<bigint>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  if (listings.loading) return <Spinner label="Loading" />
  if (listings.error) return <ErrorNote message={listings.error} />
  const listing = (listings.data ?? []).find((l) => l.id === listingId)
  if (!listing) return <EmptyState title="Listing not found" hint="It may have been removed." action={<Link to="/"><Button>Back</Button></Link>} />

  async function reserve(slotId: bigint) {
    setBusy(true); setErr(undefined)
    try {
      setBooking(await book(slotId))
      slots.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      slots.refetch() // someone may have just taken it
    } finally {
      setBusy(false)
    }
  }

  const free = slots.data ?? []

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="overflow-hidden rounded-2xl border border-[var(--color-line)]">
        <MediaImage path={listing.photoPath} alt={listing.name} ratio="4 / 3" />
      </div>
      <div>
        <Link to="/" className="text-sm text-[var(--color-teal)] hover:underline">← All listings</Link>
        <h1 className="font-display mt-3 text-3xl font-extrabold">{listing.name}</h1>
        <div className="mt-3 flex items-center gap-3">
          <Price cents={listing.priceCents} />
          <span className="text-sm text-ink-soft nums">{listing.durationMinutes.toString()} min</span>
        </div>

        {booking !== undefined ? (
          <div className="mt-6 card p-5">
            <p className="font-display text-lg">Reserved ✓</p>
            <p className="mt-1 text-sm text-ink-soft">Booking #{booking.toString()} confirmed.</p>
            <Button className="mt-3" onClick={() => nav('/mine')}>View my reservations</Button>
          </div>
        ) : (
          <>
            <h2 className="mt-6 font-display text-lg font-bold">Available times</h2>
            {slots.loading ? (
              <div className="mt-3"><Spinner /></div>
            ) : free.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">No open times right now — check back soon.</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {free.map((s) => (
                  <button key={s.id.toString()} onClick={() => reserve(s.id)} disabled={busy}
                    className="rounded-xl border border-[var(--color-line)] bg-surface px-3 py-2 text-sm font-medium transition hover:border-[var(--color-teal)] hover:text-[var(--color-teal-ink)] disabled:opacity-50">
                    {slotTime(s.startNs)}
                  </button>
                ))}
              </div>
            )}
            {err && <div className="mt-4"><ErrorNote message={err} /></div>}
          </>
        )}
      </div>
    </div>
  )
}
