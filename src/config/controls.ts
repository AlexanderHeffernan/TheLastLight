export type MobileControlScheme = 'drag-aim' | 'twin-stick';

export const DEFAULT_MOBILE_CONTROL_SCHEME: MobileControlScheme = 'twin-stick';

const MOBILE_CONTROL_SCHEME_KEY = 'the-last-light-mobile-control-scheme';

let activeMobileControlScheme: MobileControlScheme = DEFAULT_MOBILE_CONTROL_SCHEME;

export function hasTouchControls(): boolean {
  return typeof window !== 'undefined'
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}

export function loadMobileControlScheme(): MobileControlScheme {
  if (typeof window === 'undefined') return activeMobileControlScheme;

  const stored = window.localStorage.getItem(MOBILE_CONTROL_SCHEME_KEY);
  activeMobileControlScheme = stored === 'twin-stick' ? 'twin-stick' : DEFAULT_MOBILE_CONTROL_SCHEME;
  return activeMobileControlScheme;
}

export function setMobileControlScheme(scheme: MobileControlScheme): void {
  activeMobileControlScheme = scheme;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(MOBILE_CONTROL_SCHEME_KEY, scheme);
  }
}

export function getMobileControlScheme(): MobileControlScheme {
  return activeMobileControlScheme;
}
