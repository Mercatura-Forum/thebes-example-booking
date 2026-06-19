import { NavLink, Outlet } from 'react-router-dom'
import { SignOutChip } from './MemphisGate'

const tabs = [
  { to: '/', label: 'Browse', end: true },
  { to: '/mine', label: 'My reservations' },
  { to: '/admin', label: 'Admin' },
]

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <NavLink to="/" className="font-display text-2xl font-extrabold tracking-tight">
            harbor<span className="text-[var(--color-teal)]">~</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${isActive ? 'bg-[var(--color-teal)]/10 text-[var(--color-teal-ink)]' : 'text-ink-soft hover:text-ink'}`}>
                {t.label}
              </NavLink>
            ))}
            <SignOutChip className="ml-2 border-l border-[var(--color-line)] pl-3" />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8"><Outlet /></main>
      <footer className="mx-auto max-w-6xl px-5 py-8 text-xs text-ink-soft">
        Reserve anything on-chain — a boat, a car, a studio, an appointment. Every
        listing, photo, and booking lives on the chain; no double-bookings.
      </footer>
    </div>
  )
}
