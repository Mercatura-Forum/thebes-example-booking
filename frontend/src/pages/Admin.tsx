import { useRef, useState } from 'react'
import { useQuery, useUpdate, useMediaUpload } from '@thebes/sdk'
import { BOOKING_CID, M, decodeListings, addListing, createSlots, type Listing } from '../lib/booking-api'
import { MEDIA_CID } from '../lib/config'
import { MediaImage } from '../components/MediaImage'
import { Button, Spinner, ErrorNote, Price } from '../components/ui'

function toNs(local: string): bigint {
  return BigInt(new Date(local).getTime()) * 1_000_000n
}

export function Admin() {
  const { data, loading, error, refetch } = useQuery<Listing[]>(BOOKING_CID, M.listings, undefined, decodeListings)
  const { call } = useUpdate()
  const media = useMediaUpload(MEDIA_CID)
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [duration, setDuration] = useState('60')
  const [price, setPrice] = useState('')
  const [photoPath, setPhotoPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [err, setErr] = useState<string>()

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    setErr(undefined)
    try { setPhotoPath((await media.upload(file, 'photo')).path) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  async function create() {
    setBusy(true); setErr(undefined); setNote(undefined)
    try {
      await addListing(name.trim() || 'Listing', Number(duration || '60'), BigInt(Math.round(Number(price || '0') * 100)), photoPath)
      setName(''); setPrice(''); setPhotoPath(null)
      if (fileRef.current) fileRef.current.value = ''
      setNote('Listing added')
      refetch()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
      <section className="space-y-6">
        <div className="card p-4">
          <h2 className="font-display text-lg font-bold">Owner</h2>
          <p className="mt-1 text-sm text-ink-soft">First caller claims the business; only the owner adds listings + slots.</p>
          <Button variant="ghost" className="mt-3" onClick={() => call(BOOKING_CID, 'claimOwner').then(() => setNote('Ownership claimed (if unclaimed)')).catch((e) => setErr(String(e)))}>Claim ownership</Button>
        </div>

        <div className="card p-4">
          <h2 className="font-display text-lg font-bold">Add a listing</h2>
          <div className="mt-3 flex items-center gap-4">
            <div className="w-28 shrink-0 overflow-hidden rounded-xl border border-[var(--color-line)]"><MediaImage path={photoPath ?? ''} alt="New listing" ratio="3 / 2" /></div>
            <div>
              <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickPhoto(e.target.files?.[0])}
                className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-teal)] file:px-3 file:py-1.5 file:text-white" />
              {media.busy && <p className="mt-2 text-xs text-ink-soft nums">Uploading… {Math.round(media.progress * 100)}%</p>}
              {photoPath && !media.busy && <p className="mt-2 text-xs text-[var(--color-teal-ink)]">Stored on-chain ✓</p>}
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <input className={inp} placeholder="Listing name (e.g. Sunseeker 38' boat)" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Duration (min)<input className={`${inp} nums mt-1`} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
              <label className="text-sm">Price<input className={`${inp} nums mt-1`} inputMode="decimal" placeholder="120.00" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            </div>
          </div>
          {err && <div className="mt-3"><ErrorNote message={err} /></div>}
          {note && <p className="mt-3 text-sm text-[var(--color-teal-ink)]">{note}</p>}
          <Button className="mt-4 w-full" onClick={create} disabled={busy || !name.trim() || !price}>{busy ? 'Adding…' : 'Add listing'}</Button>
        </div>
      </section>

      <section>
        <h2 className="font-display text-lg font-bold">Listings & availability</h2>
        {loading ? <div className="mt-4"><Spinner /></div> : error ? <div className="mt-4"><ErrorNote message={error} /></div> : (
          <ul className="mt-4 space-y-3">
            {(data ?? []).map((l) => <SlotMaker key={l.id.toString()} listing={l} onDone={() => setNote('Slots generated')} />)}
            {data?.length === 0 && <p className="text-sm text-ink-soft">No listings yet.</p>}
          </ul>
        )}
      </section>
    </div>
  )
}

const inp = 'w-full rounded-lg border border-[var(--color-line)] bg-paper px-3 py-2 text-sm'

function SlotMaker({ listing, onDone }: { listing: Listing; onDone: () => void }) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [interval, setInterval] = useState('60')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  async function gen() {
    if (!start || !end) return
    setBusy(true); setErr(undefined)
    try { await createSlots(listing.id, toNs(start), toNs(end), Number(interval || '60')); setStart(''); setEnd(''); onDone() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <li className="card p-3">
      <div className="flex items-center gap-3">
        <div className="h-12 w-16 shrink-0 overflow-hidden rounded-lg"><MediaImage path={listing.photoPath} alt={listing.name} ratio="3 / 2" /></div>
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{listing.name}</p></div>
        <Price cents={listing.priceCents} />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">From<input type="datetime-local" className={`${inp} mt-1`} value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="text-xs">To<input type="datetime-local" className={`${inp} mt-1`} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <label className="text-xs">Every (min)<input className={`${inp} nums mt-1 w-20`} inputMode="numeric" value={interval} onChange={(e) => setInterval(e.target.value)} /></label>
        <Button variant="ghost" onClick={gen} disabled={busy || !start || !end}>{busy ? '…' : 'Add slots'}</Button>
      </div>
      {err && <div className="mt-2"><ErrorNote message={err} /></div>}
    </li>
  )
}
