import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { fmtCents } from '../lib/config'

/** Amber price pill (the value 2-tone). */
export function Price({ cents }: { cents: bigint }) {
  return <span className="price text-sm"><span aria-hidden className="opacity-60 text-[0.7em]">$</span><span className="nums">{fmtCents(cents)}</span></span>
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }
export function Button({ variant = 'primary', className = '', ...props }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed'
  const styles: Record<string, string> = {
    primary: 'bg-[var(--color-teal)] text-white hover:brightness-110 active:brightness-95',
    ghost: 'bg-transparent text-ink ring-1 ring-[var(--color-line)] hover:bg-[var(--color-paper)]',
  }
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-soft text-sm" role="status">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-teal)]" />
      {label}…
    </div>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="card border-dashed p-10 text-center">
      <p className="font-display text-lg text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-soft">{hint}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-lg bg-[var(--color-busy)]/8 px-3 py-2 text-sm text-[var(--color-busy)]">{message}</p>
}
