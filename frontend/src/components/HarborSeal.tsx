import { useQuery } from '@thebes/sdk'
import { BOOKING_CID, M, decodeConservation, type Conservation } from '../lib/booking-api'
import { fmtCents } from '../lib/config'

/**
 * HarborSeal — the footer's live proof. Calls the public on-chain oracle and
 * shows the escrow conservation law with real numbers: collected must equal
 * held + refunded + forfeited + captured, and the five invariants must hold.
 * Anyone can verify it — that's the point of the example.
 */
export function HarborSeal() {
  const { data, loading } = useQuery<Conservation>(BOOKING_CID, M.conservation, undefined, decodeConservation)
  if (loading || !data) return null
  const ok = Number(data.ok) === 1
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] nums" data-testid="harbor-seal">
      <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-[var(--color-teal)]' : 'bg-[var(--color-busy)]'}`} />
      {ok ? (
        <>
          <span className="font-semibold text-[var(--color-teal-ink)]">Escrow conserved on-chain</span>
          <span className="text-ink-soft">
            ${fmtCents(data.collectedCents)} collected = ${fmtCents(data.heldCents)} held + ${fmtCents(data.refundedCents)} refunded
            + ${fmtCents(data.forfeitedCents)} forfeited + ${fmtCents(data.capturedCents)} captured · 0 violations across 5 invariants
          </span>
        </>
      ) : (
        <span className="font-semibold text-[var(--color-busy)]">
          Invariant oracle reports {data.violations.toString()} violation(s) — see Admin → Ledger
        </span>
      )}
    </div>
  )
}
