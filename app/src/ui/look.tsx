import React from 'react'

import { cachedBackdrop, fetchBackdrop, type Backdrop } from '../api/backdrop'
import { DEFAULT_LOOK, loadLook, saveLook, type LookPrefs, type Wallpaper } from '../api/storage'
import { useConnection } from '../state/ConnectionContext'

export type { Wallpaper }

export type LookValue = LookPrefs & {
  setTransparency: (on: boolean) => void
  setWallpaper: (kind: Wallpaper) => void
}

const LookContext = React.createContext<LookValue>({
  ...DEFAULT_LOOK,
  setTransparency: () => {},
  setWallpaper: () => {},
})

/**
 * The look the phone keeps for itself.
 *
 * Colours come from the desktop; these two do not. Transparency decides
 * whether a card is glass over the wallpaper or a solid panel — it is the one
 * switch that buys back a little battery and a lot of contrast — and the
 * wallpaper is what sits behind the workspaces. Both are written to the same
 * store as the rest of the phone's preferences, so they survive a restart,
 * and both start at what the mock draws: glass over the aurora.
 */
export function LookProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = React.useState<LookPrefs>(DEFAULT_LOOK)

  React.useEffect(() => {
    let alive = true
    loadLook().then((saved) => {
      if (alive) setPrefs(saved)
    })
    return () => {
      alive = false
    }
  }, [])

  const write = React.useCallback((next: LookPrefs) => {
    setPrefs(next)
    void saveLook(next)
  }, [])

  const value = React.useMemo<LookValue>(
    () => ({
      ...prefs,
      setTransparency: (on: boolean) => write({ ...prefs, transparency: on }),
      setWallpaper: (kind: Wallpaper) => write({ ...prefs, wallpaper: kind }),
    }),
    [prefs, write],
  )

  return <LookContext.Provider value={value}>{children}</LookContext.Provider>
}

export function useLook(): LookValue {
  return React.useContext(LookContext)
}

/* ── the desktop's own wallpaper ─────────────────────────────────────── */

/**
 * The picture the desktop is wearing, or null until there is one.
 *
 * The cached copy is painted first, so switching back to this phone does not
 * mean waiting on the socket, and the desktop is then asked only whether that
 * copy is still current — it answers `unchanged` and sends nothing almost
 * every time. A theme switch repaints the palette, and the palette's name is
 * what brings the picture back around with it.
 */
export function useBackdrop(enabled: boolean): Backdrop | null {
  const { call, can, status, palette } = useConnection()
  const [picture, setPicture] = React.useState<Backdrop | null>(null)
  const held = React.useRef<Backdrop | null>(null)

  // Switching back to the gradient puts the picture away — it stays in the
  // cache, and the ask after the next switch answers `unchanged`, but holding
  // it on screen under a background the phone is no longer set to would not
  // be putting it away at all.
  React.useEffect(() => {
    if (!enabled) {
      setPicture(null)
      return
    }
    if (!held.current) held.current = cachedBackdrop()
    setPicture(held.current)
  }, [enabled])

  React.useEffect(() => {
    if (!enabled || status !== 'connected' || !can('desktop', 'background')) return
    let alive = true
    fetchBackdrop(call, held.current)
      .then((next) => {
        if (!alive || !next) return
        held.current = next
        setPicture(next)
      })
      .catch(() => {
        /* the gradient is behind this one; a wallpaper that will not come is
           not worth a notice on every screen. */
      })
    return () => {
      alive = false
    }
  }, [enabled, status, can, call, palette.name])

  return picture
}

/* ── what the bar is waiting on ──────────────────────────────────────── */

const AsksContext = React.createContext<{ count: number; report: (count: number) => void }>({
  count: 0,
  report: () => {},
})

/**
 * How many things on Setup are asking to be answered — an Android permission
 * that was never granted, mostly. The Setup screen counts them; the Omarchy
 * bar wears the number as a badge on workspace 5, the way it wears agents
 * waiting on workspace 2.
 */
export function SetupAsksProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = React.useState(0)
  const value = React.useMemo(() => ({ count, report: setCount }), [count])
  return <AsksContext.Provider value={value}>{children}</AsksContext.Provider>
}

/** The badge's number. 0 while nothing has reported one. */
export function useSetupAsks(): number {
  return React.useContext(AsksContext).count
}

/** Setup calls this with its own count whenever it changes. */
export function useReportSetupAsks(): (count: number) => void {
  return React.useContext(AsksContext).report
}
