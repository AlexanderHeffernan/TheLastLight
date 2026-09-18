export function hasTouchControls(): boolean {
  return typeof window !== 'undefined'
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}

export function isMobilePortraitViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(orientation: portrait)').matches
    && (hasTouchControls() || window.matchMedia('(max-width: 720px)').matches);
}
