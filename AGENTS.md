# AGENTS.md — deploying this example

A canonical, copy-pasteable contract for an automated agent deploying
`thebes-example-booking` to a Thebes cluster. Human-readable detail is in
[README.md](README.md).

## Layout

```
thebes.toml                 deploy manifest (network + canisters)
motoko/main.mo              backend (Motoko); imports mo:thebes-lib/Admin
motoko/thebes-lib/          vendored backend library (local Mops dep — no external pin)
frontend/                   React + Vite app on @thebes/sdk
frontend/vendor/@thebes/sdk vendored SDK (local file: dep — no external pin)
```

## Toolchain (exact)

- Motoko compiler **1.4.1**, fetched by `mops install` to
  `~/.cache/mops/moc/1.4.1/moc` (macOS: `~/Library/Caches/mops/moc/1.4.1/moc`).
  Do **not** invoke a bare `moc` — a default `PATH` may resolve a different
  compiler version or Qt's Meta-Object Compiler.
- Node 18+, Mops, and the `thebes-deploy` CLI (Linux x86-64 prebuilt; build from
  the release source bundle on other platforms).
- `mops install` prints `core@2.5.0 requires moc >= 1.6.0` while 1.4.1 is pinned.
  This is expected — the cluster pins 1.4.1 and the build succeeds.

## Deploy

```sh
# 0. network: replace NODE_A..NODE_D in thebes.toml [networks.wan].validators
#    with the endpoints printed by:
thebes-deploy init            # prints current WAN cluster validators

# 1. backend
thebes-deploy identity new me
thebes-deploy deploy booking  # → prints the backend cid (call it BOOKING_CID)

# 2. frontend
curl -L -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
cd frontend && npm install && npm run build && cd ..
sed -i 's#<head>#<head><script>window.BOOKING_CID=BOOKING_CID;</script>#' frontend/dist/index.html
thebes-deploy deploy web      # → prints https://memphis.mercaturaforum.com/_/raw/<cid>/index.html
```

Verify: `curl -s -o /dev/null -w '%{http_code}' <printed-url>` returns `200`.

## Calling the backend

```sh
thebes-deploy query booking getServices                    # queries need no identity
thebes-deploy call  booking seedDemo                        # updates need a local identity
```

Candid arguments use textual form and **must** be passed via `--arg`; positional
arguments after the method name are rejected:

```sh
thebes-deploy call booking bookAppointmentOrTrap --arg '(0 : nat)'
thebes-deploy call booking addServiceOrTrap \
  --arg '("Haircut", 30 : nat, 4500 : nat, null)'
```

Public methods on `booking` (see `motoko/main.mo`):

- Admin (controller-gated): `claimOwner`, `transferOwner`, `addAdmin`,
  `removeAdmin`, `setPaused`; queries `getOwner`, `getAdmins`, `isPaused`.
- Services: `addService` / `addServiceOrTrap`, `setServicePhoto` /
  `setServicePhotoOrTrap`; query `getServices`; flat view `servicesView`.
- Slots: `createSlots` / `createSlotsOrTrap`; query `getAvailableSlots`; flat
  view `availableSlotsView`.
- Bookings: `bookAppointment` / `bookAppointmentOrTrap`, `cancelBooking`;
  per-caller queries `getMyBookings`, `getSchedule`; flat view `myBookingsView`.
- Demo data: `seedDemo`.

## Conventions that affect correctness

- **`window.BOOKING_CID`** (and optional `window.MEDIA_CID`) are injected into the
  built page at deploy time; the frontend reads them at runtime. If you skip the
  injection step, the page falls back to compiled-in defaults and talks to the
  wrong backend.
- **`*OrTrap` methods** (e.g. `bookAppointmentOrTrap`) trap on a failed guard — for
  booking, the double-booking guard — so the client sees a rejection instead of a
  silently-swallowed error. Frontends call the `OrTrap` form for any guarded write.
- **Boundary decoding** returns a `vec record` of scalar fields. A single record is
  a 0-or-1-element array; principal fields are 56-character hex. Decode with the
  SDK's `decodeVecRecord` / `decodeNat` / `decodeBool`.
