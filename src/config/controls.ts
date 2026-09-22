const TOUCH_CONTROLS_MEDIA_QUERY = '(pointer: coarse) and (hover: none) and (any-hover: none)';
const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i;

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
}

function isWindowsDesktopBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const browserNavigator = navigator as NavigatorWithUserAgentData;
  const userAgent = browserNavigator.userAgent;
  const platform = browserNavigator.userAgentData?.platform ?? browserNavigator.platform;
  const isWindows = /Windows NT/i.test(userAgent) || /^Win/i.test(platform);
  const isMobile = browserNavigator.userAgentData?.mobile === true
    || MOBILE_USER_AGENT.test(userAgent);
  return isWindows && !isMobile;
}

export function hasTouchControls(): boolean {
  if (typeof window === 'undefined') return false;

  // Touch capability is not the same as a touch-first device. Windows browsers
  // can expose touch APIs for hybrid hardware (and sometimes for desktop
  // configurations), which would otherwise replace mouse controls with the
  // twin-stick UI. Only use touch controls when the primary pointer is coarse
  // and no available pointer can hover.
  if (!window.matchMedia(TOUCH_CONTROLS_MEDIA_QUERY).matches) return false;

  // Brave on Windows can report touch-first media features for a desktop
  // profile. Keep mouse-and-keyboard controls on Windows desktop; mobile
  // Windows user agents still use the touch path above.
  return !isWindowsDesktopBrowser();
}

export function isMobilePortraitViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(orientation: portrait)').matches
    && (hasTouchControls() || window.matchMedia('(max-width: 720px)').matches);
}
