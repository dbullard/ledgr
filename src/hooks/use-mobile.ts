import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // useSyncExternalStore subscribes to the media query without calling
  // setState inside an effect (react-hooks/set-state-in-effect). The server
  // snapshot defaults to false so SSR renders the desktop layout, then the
  // client snapshot corrects it on hydration.
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  )
}

/** True once the viewport is at least `px` wide. Same SSR approach as above. */
export function useMinWidth(px: number) {
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(`(min-width: ${px}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.innerWidth >= px,
    () => true,
  )
}
