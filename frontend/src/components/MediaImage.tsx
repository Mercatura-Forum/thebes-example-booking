import { useState } from 'react'
import { mediaUrl } from '@thebes/sdk'
import { MEDIA_CID } from '../lib/config'

/**
 * The universal media primitive: a fixed aspect-ratio box with object-cover and
 * a blur-up reveal on load. Our images are pre-bounded by the contract (pass-3),
 * so we ship the single stored size — no srcset ladder. Empty path renders a
 * quiet placeholder rather than a broken image.
 */
export function MediaImage({
  path,
  alt,
  ratio = '4 / 3',
  className = '',
}: {
  path: string
  alt: string
  ratio?: string
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  if (!path) {
    return (
      <div
        className={`media grid place-items-center text-ink-soft/50 ${className}`}
        style={{ aspectRatio: ratio }}
        aria-label={`${alt} — no image`}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </div>
    )
  }
  return (
    <div className={`media ${className}`} style={{ aspectRatio: ratio }}>
      <img
        src={mediaUrl(MEDIA_CID, path)}
        alt={alt}
        loading="lazy"
        decoding="async"
        data-loaded={loaded}
        onLoad={() => setLoaded(true)}
      />
    </div>
  )
}
