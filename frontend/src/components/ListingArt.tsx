import { useMemo } from 'react'

/**
 * ListingArt — procedural "chart plate" art for listings without a photo.
 * Each kind gets its own sea-chart: a soft wash in the kind's hue, seeded
 * depth-contour lines (like a nautical chart), and a drawn line glyph. All
 * SVG, all generated from (kind, id) — no assets, and no two plates repeat.
 */

const HUES: Record<string, [string, string, string]> = {
  //            wash-from   wash-to     stroke
  sail: ['#e3f2f0', '#cfe9e5', '#0f8a82'],
  ev: ['#e7eef8', '#d5e2f2', '#3565a8'],
  studio: ['#f3e9f2', '#e7d6e6', '#8a4a86'],
  court: ['#eaf3e3', '#d9ead0', '#4d7c3a'],
  sauna: ['#f8ece3', '#f2ddcc', '#b0652a'],
  loft: ['#f0eee7', '#e5e1d3', '#7d7451'],
}
const FALLBACK: [string, string, string] = ['#e9f0ef', '#dbe7e5', '#3f6f6a']

/** Deterministic PRNG so every listing's plate is stable across renders. */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function contour(rand: () => number, y: number, amp: number): string {
  const pts: string[] = [`M 0 ${y.toFixed(1)}`]
  for (let x = 0; x <= 400; x += 40) {
    const yy = y + Math.sin(x / (52 + rand() * 30) + rand() * 6) * amp + (rand() - 0.5) * amp * 0.6
    pts.push(`${x === 0 ? 'L' : 'L'} ${x} ${yy.toFixed(1)}`)
  }
  return pts.join(' ')
}

function glyph(kind: string): string {
  switch (kind) {
    case 'sail': // hull + main + jib
      return 'M120 178 L280 178 L262 196 L138 196 Z M196 60 L196 172 M196 76 L262 168 L200 168 Z M188 92 L142 166 L188 166 Z'
    case 'ev': // hatchback silhouette + wheels + charge bolt
      return 'M112 172 L136 138 Q150 118 178 116 L232 116 Q258 118 272 140 L288 158 L288 172 Z M148 172 a14 14 0 1 0 0.1 0 M252 172 a14 14 0 1 0 0.1 0 M205 96 L191 122 L205 122 L195 146'
    case 'studio': // large-diaphragm mic in shockmount
      return 'M200 66 a30 30 0 0 1 30 30 L230 128 a30 30 0 0 1 -60 0 L170 96 a30 30 0 0 1 30 -30 Z M172 100 L228 100 M172 118 L228 118 M200 158 L200 186 M172 186 L228 186 M154 96 a46 46 0 0 0 92 26'
    case 'court': // racket + ball
      return 'M156 64 a44 56 0 1 0 60 78 L246 186 M170 92 L200 92 M162 112 L208 112 M164 132 L204 132 M186 74 L186 148 M258 118 a12 12 0 1 0 0.1 0'
    case 'sauna': // bench + rising steam
      return 'M128 156 L272 156 M144 156 L144 186 M256 156 L256 186 M160 128 Q152 112 160 98 Q168 84 160 68 M200 128 Q192 112 200 98 Q208 84 200 68 M240 128 Q232 112 240 98 Q248 84 240 68'
    case 'loft': // camera
      return 'M136 108 L168 108 L180 90 L220 90 L232 108 L264 108 Q276 108 276 120 L276 172 Q276 184 264 184 L136 184 Q124 184 124 172 L124 120 Q124 108 136 108 Z M200 146 a26 26 0 1 0 0.1 0 M248 122 L258 122'
    default: // anchor
      return 'M200 74 a14 14 0 1 0 0.1 0 M200 102 L200 182 M164 120 L236 120 M148 150 Q166 186 200 188 Q234 186 252 150 M148 150 L166 148 M252 150 L234 148'
  }
}

export function ListingArt({ kind, seed, className = '', ratio = '3 / 2' }: { kind: string; seed: number; className?: string; ratio?: string }) {
  const [from, to, stroke] = HUES[kind] ?? FALLBACK
  const paths = useMemo(() => {
    const rand = mulberry(seed * 7919 + kind.length * 131)
    return [0, 1, 2, 3, 4].map((i) => contour(rand, 62 + i * 42, 7 + rand() * 7))
  }, [kind, seed])
  const gid = `wash-${kind}-${seed}`
  return (
    <div className={`media ${className}`} style={{ aspectRatio: ratio }}>
      <svg viewBox="0 0 400 260" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${kind} artwork`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor={from} />
            <stop offset="1" stopColor={to} />
          </linearGradient>
        </defs>
        <rect width="400" height="260" fill={`url(#${gid})`} />
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={stroke} strokeOpacity={0.14 + i * 0.02} strokeWidth="1" />
        ))}
        <path d={glyph(kind)} fill="none" stroke={stroke} strokeOpacity="0.9" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
