/**
 * Should a freshly-mounted input grab focus on its own?
 *
 * On a desktop (fine pointer + hover) auto-focusing a search box or the first
 * field is a courtesy — the dealer just starts typing. On a touch-primary phone
 * or tablet the SAME auto-focus pops the on-screen keyboard the instant a panel
 * opens (the fabric picker on the public link, a new quote line in the editor),
 * covering half the screen before the user has decided to type anything. So we
 * gate auto-focus on the device: keep it on desktop, drop it on touch and let
 * the user tap into the field when they actually want the keyboard.
 *
 * Mirrors the (pointer: coarse) + (hover: none) test used elsewhere for
 * touch-primary detection — convertibles with a trackpad keep auto-focus.
 */
export function shouldAutoFocusInput() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const noHover = window.matchMedia('(hover: none)').matches;
  return !(coarse && noHover);
}
