import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { BOOKING_CID, M, decodeListings, decodeBoard, seedDemo, type Listing, type BoardSlot } from '../lib/booking-api'
import { fmtDuration } from '../lib/config'
import { fmtSlot } from '../lib/chainTime'
import { MediaImage } from '../components/MediaImage'
import { ListingArt } from '../components/ListingArt'
import { TideClock } from '../components/TideClock'
import { Price, Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

export function Browse() {
  const listings = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  const board = useQuery<BoardSlot[]>(BOOKING_CID, M.board, undefined, decodeBoard)
  const [seeding, setSeeding] = useState(false)
  const [seedErr, setSeedErr] = useState<string>()

  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of listings.data ?? []) m.set(l.id.toString(), l.name)
    return m
  }, [listings.data])

  async function seed() {
    setSeeding(true); setSeedErr(undefined)
    try { await seedDemo(); listings.refetch(); board.refetch() }
    catch (e) { setSeedErr(e instanceof Error ? e.message : String(e)) }
    finally { setSeeding(false) }
  }

  if (listings.loading) return <Spinner label="Loading the harbor" />
  if (listings.error) return <ErrorNote message={listings.error} />
  const rows = (listings.data ?? []).filter((l) => Number(l.archived) === 0)

  if (rows.length === 0) {
    return (
      <div>
        <EmptyState
          title="The harbor is empty"
          hint="Load the demo harbor to see it live — six listings, a week of slots, real bookings — or add your own at the front desk."
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button onClick={seed} disabled={seeding}>{seeding ? 'Loading…' : 'Load the demo harbor'}</Button>
              <Link to="/admin"><Button variant="ghost">Front desk</Button></Link>
            </div>
          }
        />
        {seedErr && <div className="mx-auto mt-4 max-w-md"><ErrorNote message={seedErr} /></div>}
      </div>
    )
  }

  const weekSeats = (board.data ?? []).reduce((n, s) => n + Number(s.remaining), 0)

  return (
    <div>
      {/* ── Hero: the Tide Clock — this week's real availability, live from the chain ── */}
      <section className="hero grid items-center gap-4 p-7 sm:p-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="max-w-xl">
          <p className="hero-kicker">Live from the chain</p>
          <h1 className="font-display mt-3 text-4xl font-extrabold leading-[1.05] sm:text-5xl">
            The week's tide of <span className="text-[var(--color-teal)]">open time</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
            Every arc on the clock is a real slot in the contract — teal while seats
            remain, dark once full. Seats can never oversell: the same atomic step
            that checks capacity writes the booking, and a public oracle re-proves
            it on every read.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <a href="#listings"><Button>Browse listings</Button></a>
            <p className="text-sm text-ink-soft nums">
              <span className="font-display font-bold text-ink">{weekSeats}</span> seats open over 7 days
            </p>
          </div>
        </div>
        <TideClock board={board.data ?? []} names={names} className="mx-auto h-[320px] w-[320px] sm:h-[420px] sm:w-[420px]" />
      </section>

      {/* ── Listings ── */}
      <div id="listings" className="mt-10 flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-extrabold">Reserve anything</h2>
        <p className="text-sm text-ink-soft">A boat, a car, a studio, a court — no double-bookings, ever.</p>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((l) => {
          const util = Number(l.utilizationBps) / 100
          return (
            <Link key={l.id.toString()} to={`/l/${l.id}`}
              className="card overflow-hidden transition hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-16px_rgba(12,47,44,0.35)]">
              {l.photoPath
                ? <MediaImage path={l.photoPath} alt={l.name} ratio="3 / 2" />
                : <ListingArt kind={l.kind} seed={Number(l.id)} ratio="3 / 2" />}
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display font-bold leading-tight line-clamp-1">{l.name}</p>
                    <p className="mt-0.5 text-xs text-ink-soft nums">
                      {fmtDuration(l.durationMinutes)} · up to {l.capacity.toString()} {Number(l.capacity) === 1 ? 'guest' : 'guests'}
                    </p>
                  </div>
                  <Price cents={l.priceCents} />
                </div>
                <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-soft nums">
                  <div className="tidebar flex-1"><span style={{ width: `${Math.min(util, 100)}%` }} /></div>
                  <span>{Math.round(util)}% booked</span>
                </div>
                <p className="mt-2 text-xs text-ink-soft nums">
                  {Number(l.slotsFree) > 0 && l.nextFreeNs !== 0n
                    ? <>Next free: <span className="font-semibold text-[var(--color-teal-ink)]">{fmtSlot(l.nextFreeNs)}</span></>
                    : <span className="text-[var(--color-busy)] font-semibold">Fully booked this week</span>}
                </p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
