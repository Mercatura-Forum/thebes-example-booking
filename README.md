# thebes-example-booking

Harbor — an on-chain reservation engine built on
[Thebes Protocol](https://thebesprotocol.com): a Motoko
backend that holds listings, seated slots, waitlists and a deposit escrow, and a
React frontend served as certified assets.

The property this example proves: **a slot can never be booked beyond its
capacity, and every cent of deposit money is accounted for.** Seats are a
counting guard (the check and the writes share one synchronous call, so two
concurrent callers can never both take the last seat); cancellation follows a
per-listing refund window; full slots take a FIFO waitlist that auto-promotes
the moment seats free; and a **public invariant oracle**
(`invariantReportView`) recomputes five laws from raw state on every read —
capacity, waitlist fairness, escrow conservation
(collected = held + refunded + forfeited + captured), schedule integrity, and
index integrity. An empty report is the proof.

Live demo: <https://memphis.mercaturaforum.com/_/raw/177129167469535/index.html>

## Architecture

```
frontend (React + Vite + Tailwind)   →   booking backend (Motoko)
   @thebes/sdk  ── boundary client       mo:thebes-lib ── Admin
   Memphis passkey gate                  listings · slots · bookings · waitlists · escrow
```

- **frontend/** uses `@thebes/sdk` for the boundary client, typed query/update
  calls, React hooks, and the Memphis passkey gate. The SDK is **vendored** under
  `frontend/vendor/@thebes/sdk` and resolved as a local dependency
  (upstream source of truth: [`thebes-sdk`](https://github.com/Mercatura-Forum/thebes-sdk)).
- **motoko/** uses `thebes-lib` for `Admin` (controller-gated operations); the
  booking logic lives in `main.mo`. The library is **vendored** under
  `motoko/thebes-lib` and resolved as a local Mops dependency.

Both halves are self-contained: the repository builds with no external Git or Mops
toolkit pins. The frontend asset-canister wasm is the one artifact fetched at
deploy time (see [Deploy](#deploy)).

## Backend interface (selected)

| Method | Kind | Purpose |
| --- | --- | --- |
| `listingsView` / `slotsView` / `boardView` | query | Browse listings, a listing's future slots (with seats and waitlist state), and the whole week's open slots. |
| `bookOrTrap` | update | Take seats on a slot; traps on the capacity guard (`"Only N seat(s) left"`) so the client never silently ignores an error. |
| `cancelBookingOrTrap` | update | Cancel; refunds in full before the listing's window closes, forfeits after — then promotes the waitlist. |
| `joinWaitlistOrTrap` / `leaveWaitlistOrTrap` | update | Queue for a full slot (FIFO, auto-promoted). |
| `checkInOrTrap` / `markNoShowOrTrap` / `completeOrTrap` | update | Front-desk lifecycle; completing captures the deposit, a no-show forfeits it. |
| `addListingOrTrap` / `publishSlotsOrTrap` / `closeSlotOrTrap` | update | Owner surface; publishing rejects any batch that would overlap existing slots, closing refunds every active booking in full. |
| `myBookingsView` / `myWaitlistView` / `agendaView` | query | Caller-scoped bookings and waitlists; the owner's day agenda. |
| `invariantReportView` / `conservationView` / `statsView` | query | The public oracle, the escrow seal, and program stats. |
| `claimOwner` / `addAdmin` / `setPaused` | update | Ownership and admin surface (from `thebes-lib`'s `Admin`). |

Deposits are integer cents; every timestamp is chain nanoseconds (counted from
genesis — clients calibrate via `timeView`, which returns the chain's now).

## Toolchain

- **Motoko compiler 1.4.1.** `mops install` fetches the pinned compiler to
  `~/.cache/mops/moc/1.4.1/moc` (macOS: `~/Library/Caches/mops/moc/1.4.1/moc`).
  Use that binary — the `moc` on a default `PATH` may be a different version, or
  Qt's unrelated Meta-Object Compiler.
- **Node 18+** and **[Mops](https://mops.one)** for the two builds.
- **[`thebes-deploy`](https://github.com/Mercatura-Forum/Thebes-Protocol-/releases)**
  to deploy. The prebuilt binary is Linux x86-64; on other platforms build it from
  the release source bundle (`cargo build --release -p thebes-deploy`).

## Run locally

```sh
# Frontend
cd frontend
npm install            # resolves the vendored @thebes/sdk
npm run dev            # sync-sdk copies the browser runtimes into public/, then Vite serves

# Backend (compile-check)
cd ../motoko
mops install           # resolves the vendored thebes-lib + the pinned compiler
"$(ls "$HOME/.cache/mops/moc/1.4.1/moc" "$HOME/Library/Caches/mops/moc/1.4.1/moc" 2>/dev/null | head -1)" --check $(mops sources) main.mo
```

## Deploy

`thebes.toml` describes the deploy. It ships with the current WAN cluster
validator endpoints already filled in — `thebes-deploy init` reprints the current
set if they ever change.

> **Deploying your own copy?** The committed `cid` values pin the **live catalog
> deployment** (that's what the demo links serve — only its controller can
> upgrade it). Before your first deploy, set `cid = "auto"` on each canister:
> the deploy allocates fresh canisters you control and writes their ids back
> into the manifest.

### 1. Backend

```sh
thebes-deploy identity new me      # one-time local signing identity
thebes-deploy deploy booking       # build + install + verify → prints the backend cid
```

### 2. Frontend

The frontend installs an asset canister, then uploads your built bundle. Fetch the
asset-canister wasm once (it is referenced by `thebes.toml` as `asset_canister.wasm`):

```sh
curl -L -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
```

Build the bundle and point it at your backend cid (the frontend reads
`window.BOOKING_CID` at runtime), then deploy:

```sh
cd frontend && npm run build && cd ..
# inject the backend cid from step 1 into the built page:
sed -i 's#<head>#<head><script>window.BOOKING_CID=YOUR_BOOKING_CID;</script>#' frontend/dist/index.html
thebes-deploy deploy web           # install asset canister + upload bundle + verify
```

The deploy prints the live URL:
`https://memphis.mercaturaforum.com/_/raw/<web-cid>/index.html`.

> Service photos are served by a separate media canister via `window.MEDIA_CID`.
> It is optional — without one, services render without images.

For a machine-readable deploy contract, see [AGENTS.md](AGENTS.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
