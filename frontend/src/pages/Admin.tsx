import { useMemo, useRef, useState } from 'react'
import { useQuery, useMediaUpload } from '@thebes/sdk'
import {
  BOOKING_CID, M, decodeListings, decodeAgenda, decodeConservation, decodeViolations,
  decodeStats, decodeAudit, natArg, rangeArgs,
  claimOwner, addListing, updateListing, archiveListing, publishSlots,
  checkIn, markNoShow, complete,
  type Listing, type AgendaRow, type Conservation, type Violation, type Stats, type AuditEvent,
} from '../lib/booking-api'
import { MEDIA_CID, fmtCents, fmtDuration } from '../lib/config'
import { toChainNs, fmtClock, fmtSlot, chainNowNs } from '../lib/chainTime'
import { MediaImage } from '../components/MediaImage'
import { ListingArt } from '../components/ListingArt'
import { Button, Spinner, ErrorNote, Price } from '../components/ui'

const inp = 'w-full rounded-xl border border-[var(--color-line)] bg-surface px-3 py-2 text-sm outline-none focus:border-[var(--color-teal)]'

type Tab = 'agenda' | 'listings' | 'ledger' | 'audit'

export function Admin() {
  const [tab, setTab] = useState<Tab>('agenda')
  const [note, setNote] = useState<string>()
  const [err, setErr] = useState<string>()

  const flash = (fn: () => Promise<unknown>, okNote: string, after?: () => void) => async () => {
    setErr(undefined); setNote(undefined)
    try { await fn(); setNote(okNote); after?.() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">Front desk</h1>
        <Button variant="ghost" onClick={flash(claimOwner, 'Ownership claimed (if it was unclaimed).')}>Claim ownership</Button>
      </div>
      <p className="mt-1 text-sm text-ink-soft">First caller claims the business. Owners and granted admins run the desk; everything they do lands in the audit trail.</p>

      <div className="mt-5 flex gap-1 border-b border-[var(--color-line)]">
        {(['agenda', 'listings', 'ledger', 'audit'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-t-lg px-4 py-2 text-sm font-semibold capitalize transition ${tab === t ? 'border border-b-0 border-[var(--color-line)] bg-surface text-ink' : 'text-ink-soft hover:text-ink'}`}>
            {t}
          </button>
        ))}
      </div>

      {note && <p className="mt-4 rounded-lg bg-[var(--color-teal)]/10 px-3 py-2 text-sm text-[var(--color-teal-ink)]">{note}</p>}
      {err && <div className="mt-4"><ErrorNote message={err} /></div>}

      <div className="mt-5">
        {tab === 'agenda' && <AgendaTab flash={flash} />}
        {tab === 'listings' && <ListingsTab flash={flash} />}
        {tab === 'ledger' && <LedgerTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  )
}

type Flash = (fn: () => Promise<unknown>, okNote: string, after?: () => void) => () => Promise<void>

// ── Agenda: the day's bookings, with the whole lifecycle on buttons ──

function AgendaTab({ flash }: { flash: Flash }) {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10))
  const range = useMemo(() => {
    const from = new Date(day + 'T00:00:00')
    const to = new Date(from.getTime() + 86_400_000)
    return rangeArgs(toChainNs(from.getTime()), toChainNs(to.getTime()))
  }, [day])
  const agenda = useQuery<AgendaRow[]>(BOOKING_CID, M.agenda, range, decodeAgenda, [day])
  const now = chainNowNs()

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-semibold">Day
          <input type="date" className={`${inp} mt-1`} value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <p className="text-xs text-ink-soft">Empty agenda? You may not be an admin yet — claim ownership, or have the owner grant your principal (it's in the audit trail after any action).</p>
      </div>
      {agenda.loading ? <div className="mt-4"><Spinner /></div> : (
        <ul className="mt-4 space-y-2">
          {(agenda.data ?? []).length === 0 && <li className="card border-dashed p-6 text-center text-sm text-ink-soft">Nothing on the books for this day.</li>}
          {(agenda.data ?? []).map((r) => {
            const started = r.startNs <= now
            return (
              <li key={r.bookingId.toString()} className="card flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    <span className="nums">{fmtClock(r.startNs)}–{fmtClock(r.endNs)}</span> · {r.listingName}
                    {Number(r.promoted) === 1 && <span className="ml-2 text-[10px] font-bold text-[var(--color-amber)]">FROM WAITLIST</span>}
                  </p>
                  <p className="text-xs text-ink-soft nums">
                    #{r.bookingId.toString()} · {r.seats.toString()} seat{Number(r.seats) > 1 ? 's' : ''} · ${fmtCents(r.depositCents)} ·
                    guest <span className="font-mono">{r.customer.slice(0, 10)}…</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`status-chip status-${r.status.replace(' ', '-')}`}>{r.status}</span>
                  {r.status === 'confirmed' && (
                    <>
                      <Button variant="ghost" onClick={flash(() => checkIn(r.bookingId), `Checked in booking #${r.bookingId}.`, agenda.refetch)}>Check in</Button>
                      {started && <Button variant="ghost" onClick={flash(() => markNoShow(r.bookingId), `Marked #${r.bookingId} a no-show — deposit forfeited.`, agenda.refetch)}>No-show</Button>}
                    </>
                  )}
                  {r.status === 'checked-in' && (
                    <Button onClick={flash(() => complete(r.bookingId), `Completed #${r.bookingId} — deposit captured.`, agenda.refetch)}>Complete</Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── Listings: add, edit, archive, publish slots ──

function ListingsTab({ flash }: { flash: Flash }) {
  const listings = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <AddListingCard onAdded={listings.refetch} flash={flash} />
      <div className="space-y-4">
        {listings.loading && <Spinner />}
        {(listings.data ?? []).map((l) => (
          <ListingRow key={l.id.toString()} l={l} flash={flash} refetch={listings.refetch} />
        ))}
      </div>
    </div>
  )
}

function AddListingCard({ onAdded, flash }: { onAdded: () => void; flash: Flash }) {
  const media = useMediaUpload(MEDIA_CID)
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('sail')
  const [duration, setDuration] = useState('60')
  const [price, setPrice] = useState('')
  const [capacity, setCapacity] = useState('1')
  const [windowH, setWindowH] = useState('24')
  const [photoPath, setPhotoPath] = useState<string | null>(null)
  const [err, setErr] = useState<string>()

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    setErr(undefined)
    try { setPhotoPath((await media.upload(file, 'photo')).path) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const create = flash(
    () => addListing(
      name.trim() || 'Listing', description.trim(), kind, Number(duration || '60'),
      BigInt(Math.round(Number(price || '0') * 100)), Number(capacity || '1'),
      Math.round(Number(windowH || '0') * 60), photoPath,
    ),
    'Listing added.',
    () => { setName(''); setDescription(''); setPrice(''); setPhotoPath(null); if (fileRef.current) fileRef.current.value = ''; onAdded() },
  )

  return (
    <div className="card h-fit p-4">
      <h2 className="font-display text-lg font-bold">Add a listing</h2>
      <div className="mt-3 flex items-center gap-4">
        <div className="w-28 shrink-0 overflow-hidden rounded-xl border border-[var(--color-line)]">
          {photoPath ? <MediaImage path={photoPath} alt="New listing" ratio="3 / 2" /> : <ListingArt kind={kind} seed={99} ratio="3 / 2" />}
        </div>
        <div>
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickPhoto(e.target.files?.[0])}
            className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-teal)] file:px-3 file:py-1.5 file:text-white" />
          {media.busy && <p className="mt-2 text-xs text-ink-soft nums">Uploading… {Math.round(media.progress * 100)}%</p>}
          {photoPath && !media.busy && <p className="mt-2 text-xs text-[var(--color-teal-ink)]">Stored on-chain ✓</p>}
          {!photoPath && <p className="mt-2 text-xs text-ink-soft">No photo? The chart plate above is drawn for the kind.</p>}
        </div>
      </div>
      <div className="mt-4 space-y-3">
        <input className={inp} placeholder="Listing name (e.g. Sunseeker 38')" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className={inp} rows={2} placeholder="One line guests will read" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Kind
            <select className={`${inp} mt-1`} value={kind} onChange={(e) => setKind(e.target.value)}>
              {['sail', 'ev', 'studio', 'court', 'sauna', 'loft'].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="text-sm">Duration (min)<input className={`${inp} nums mt-1`} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
          <label className="text-sm">Deposit / seat<input className={`${inp} nums mt-1`} inputMode="decimal" placeholder="120.00" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="text-sm">Seats / slot<input className={`${inp} nums mt-1`} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
          <label className="text-sm">Free cancel until (h before)<input className={`${inp} nums mt-1`} inputMode="numeric" value={windowH} onChange={(e) => setWindowH(e.target.value)} /></label>
        </div>
      </div>
      {err && <div className="mt-3"><ErrorNote message={err} /></div>}
      <Button className="mt-4" onClick={create}>Add listing</Button>
    </div>
  )
}

function ListingRow({ l, flash, refetch }: { l: Listing; flash: Flash; refetch: () => void }) {
  const [editing, setEditing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [name, setName] = useState(l.name)
  const [description, setDescription] = useState(l.description)
  const [kind, setKind] = useState(l.kind)
  const [price, setPrice] = useState((Number(l.priceCents) / 100).toFixed(2))
  const [windowH, setWindowH] = useState(String(Number(l.cancelWindowMinutes) / 60))
  const tomorrow9 = () => {
    const d = new Date(Date.now() + 86_400_000)
    d.setHours(9, 0, 0, 0)
    return d.toISOString().slice(0, 16)
  }
  const [from, setFrom] = useState(tomorrow9)
  const [hours, setHours] = useState('8')
  const [interval, setInterval_] = useState(String(Number(l.durationMinutes)))
  const [capacity, setCapacity] = useState(String(Number(l.capacity)))
  const archived = Number(l.archived) === 1

  const save = flash(
    () => updateListing(l.id, name.trim(), description.trim(), kind, BigInt(Math.round(Number(price) * 100)), Math.round(Number(windowH) * 60)),
    'Listing updated.',
    () => { setEditing(false); refetch() },
  )
  const publish = flash(
    () => {
      const startMs = new Date(from).getTime()
      const endMs = startMs + Number(hours) * 3_600_000
      return publishSlots(l.id, toChainNs(startMs), toChainNs(endMs), Number(interval), Number(capacity))
    },
    'Slots published.',
    () => { setPublishing(false); refetch() },
  )

  return (
    <div className={`card p-4 ${archived ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-4">
        <div className="w-24 shrink-0 overflow-hidden rounded-lg border border-[var(--color-line)]">
          {l.photoPath ? <MediaImage path={l.photoPath} alt={l.name} ratio="3 / 2" /> : <ListingArt kind={l.kind} seed={Number(l.id)} ratio="3 / 2" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-display font-bold">{l.name} {archived && <span className="text-xs font-normal text-ink-soft">(archived)</span>}</p>
              <p className="text-xs text-ink-soft nums">{l.kind} · {fmtDuration(l.durationMinutes)} · {l.capacity.toString()} seats · {l.slotsFree.toString()}/{l.slotsTotal.toString()} slots free</p>
            </div>
            <Price cents={l.priceCents} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => { setEditing(!editing); setPublishing(false) }}>{editing ? 'Close' : 'Edit'}</Button>
            <Button variant="ghost" onClick={() => { setPublishing(!publishing); setEditing(false) }}>{publishing ? 'Close' : 'Publish slots'}</Button>
            <Button variant="ghost" onClick={flash(() => archiveListing(l.id, !archived), archived ? 'Listing restored.' : 'Listing archived.', refetch)}>
              {archived ? 'Restore' : 'Archive'}
            </Button>
          </div>
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-[var(--color-line)] pt-4">
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className={inp} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="grid grid-cols-3 gap-3">
            <label className="text-sm">Kind
              <select className={`${inp} mt-1`} value={kind} onChange={(e) => setKind(e.target.value)}>
                {['sail', 'ev', 'studio', 'court', 'sauna', 'loft'].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="text-sm">Deposit / seat<input className={`${inp} nums mt-1`} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <label className="text-sm">Cancel window (h)<input className={`${inp} nums mt-1`} value={windowH} onChange={(e) => setWindowH(e.target.value)} /></label>
          </div>
          <Button onClick={save}>Save</Button>
        </div>
      )}

      {publishing && (
        <div className="mt-4 space-y-3 border-t border-[var(--color-line)] pt-4">
          <p className="text-xs text-ink-soft">
            Publishes one {fmtDuration(l.durationMinutes)} slot every interval across the window.
            The contract rejects any batch that would overlap existing slots — time can't be double-booked.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-sm">From<input type="datetime-local" className={`${inp} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm">Window (h)<input className={`${inp} nums mt-1`} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
            <label className="text-sm">Every (min)<input className={`${inp} nums mt-1`} value={interval} onChange={(e) => setInterval_(e.target.value)} /></label>
            <label className="text-sm">Seats<input className={`${inp} nums mt-1`} value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
          </div>
          <Button onClick={publish}>Publish</Button>
        </div>
      )}
    </div>
  )
}

// ── Ledger: the escrow conservation law + the invariant oracle, live ──

function LedgerTab() {
  const cons = useQuery<Conservation>(BOOKING_CID, M.conservation, undefined, decodeConservation)
  const inv = useQuery<Violation[]>(BOOKING_CID, M.invariants, undefined, decodeViolations)
  const stats = useQuery<Stats>(BOOKING_CID, M.stats, undefined, decodeStats)

  if (cons.loading || inv.loading || stats.loading) return <Spinner label="Re-proving the invariants on-chain" />
  const c = cons.data
  const v = inv.data ?? []
  const s = stats.data

  return (
    <div className="space-y-6">
      {c && (
        <div className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg font-bold">Escrow conservation</h2>
            <span className={`status-chip ${v.length === 0 ? 'status-confirmed' : 'status-cancelled'}`}>
              {v.length === 0 ? 'CONSERVED' : `${v.length} VIOLATION(S)`}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            Every cent collected must be exactly held, refunded, forfeited or captured. The oracle
            recomputes "held" from the booking book — the counter can't drift silently.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {([
              ['Collected', c.collectedCents],
              ['Held', c.heldCents],
              ['Refunded', c.refundedCents],
              ['Forfeited', c.forfeitedCents],
              ['Captured', c.capturedCents],
            ] as [string, bigint][]).map(([label, cents]) => (
              <div key={label} className="rounded-xl bg-[var(--color-paper)] p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-ink-soft">{label}</p>
                <p className="font-display mt-1 text-lg font-bold nums">${fmtCents(cents)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-5">
        <h2 className="font-display text-lg font-bold">Invariant oracle</h2>
        <p className="mt-1 text-xs text-ink-soft">Five rules recomputed from raw state on every read: capacity, waitlist fairness, escrow conservation, schedule integrity, index integrity.</p>
        {v.length === 0 ? (
          <p className="mt-3 rounded-lg bg-[var(--color-teal)]/10 px-3 py-2 text-sm font-semibold text-[var(--color-teal-ink)]" data-testid="oracle-green">
            All five invariants hold — the report is empty.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {v.map((x, i) => (
              <li key={i} className="rounded-lg bg-[var(--color-busy)]/8 px-3 py-2 text-sm text-[var(--color-busy)]">
                <span className="font-bold">{x.rule}:</span> {x.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      {s && (
        <div className="card p-5">
          <h2 className="font-display text-lg font-bold">Harbor stats</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 nums">
            {([
              ['Listings', s.listings], ['Open slots', s.slotsOpen], ['Closed slots', s.slotsClosed],
              ['Bookings', s.bookingsTotal], ['Confirmed', s.confirmed], ['Checked in', s.checkedIn],
              ['Completed', s.completed], ['Cancelled', s.cancelled], ['No-shows', s.noShows],
              ['Waitlisted', s.waitlistEntries], ['Audit events', s.auditEvents],
              ['Future seats', `${s.futureSeatsBooked}/${s.futureSeatsCapacity}`],
            ] as [string, unknown][]).map(([label, val]) => (
              <p key={label as string}><span className="text-ink-soft">{label as string}:</span> <span className="font-semibold">{String(val)}</span></p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Audit: the append-only trail ──

function AuditTab() {
  const audit = useQuery<AuditEvent[]>(BOOKING_CID, M.audit, natArg(100n), decodeAudit)
  if (audit.loading) return <Spinner label="Loading the trail" />
  const rows = audit.data ?? []
  if (rows.length === 0) {
    return <p className="card border-dashed p-6 text-center text-sm text-ink-soft">No events visible — the audit trail is owner/admin-gated. Claim ownership or ask the owner to grant your principal.</p>
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((e) => (
        <li key={e.seq.toString()} className="card flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs nums">
          <span className="text-ink-soft">#{e.seq.toString()}</span>
          <span className="font-bold text-[var(--color-teal-ink)]">{e.kind}</span>
          <span className="text-ink-soft">{fmtSlot(e.at)}</span>
          <span className="font-mono text-ink-soft">{e.who.slice(0, 10)}…</span>
          {e.note && <span className="text-ink">{e.note}</span>}
          <span className="text-ink-soft">refs {e.refA.toString()}/{e.refB.toString()}</span>
        </li>
      ))}
    </ul>
  )
}
