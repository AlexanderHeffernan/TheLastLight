export function hasTouchControls(): boolean {
  return typeof window !== 'undefined'
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}
