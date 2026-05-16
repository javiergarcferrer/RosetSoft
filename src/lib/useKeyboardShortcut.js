import { useEffect } from 'react';

/**
 * Bind a handler to a keyboard combo. Use 'mod' for the platform meta key
 * (⌘ on macOS, Ctrl elsewhere). Examples:
 *
 *   useKeyboardShortcut('mod+k', open);
 *   useKeyboardShortcut('mod+enter', addLine, { ignoreInInput: false });
 *   useKeyboardShortcut('escape', close);
 *
 * `ignoreInInput` (default true) suppresses the shortcut while the user is
 * typing in an input/textarea/contenteditable — so e.g. Cmd+K still opens
 * the palette but plain letters never collide with text entry.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function inEditable(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function matches(combo, e) {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop();
  const needMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt') || parts.includes('option');
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey;
  if (needMod !== modPressed) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  const keyLower = e.key.toLowerCase();
  // Allow 'enter' / 'return', 'esc' / 'escape', etc. to match either spelling.
  if (key === 'enter' && (keyLower === 'enter' || keyLower === 'return')) return true;
  if (key === 'escape' && (keyLower === 'escape' || keyLower === 'esc')) return true;
  return keyLower === key;
}

export function useKeyboardShortcut(combo, handler, { ignoreInInput = true, enabled = true } = {}) {
  useEffect(() => {
    if (!enabled || !combo || !handler) return;
    function onKey(e) {
      if (ignoreInInput && inEditable(e.target) && !combo.toLowerCase().includes('mod')) return;
      if (!matches(combo, e)) return;
      e.preventDefault();
      handler(e);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, handler, ignoreInInput, enabled]);
}

/** "⌘K" on Mac, "Ctrl+K" elsewhere — for display in tooltips/menus. */
export function shortcutLabel(combo) {
  return combo
    .split('+')
    .map((part) => {
      const p = part.toLowerCase().trim();
      if (p === 'mod' || p === 'cmd' || p === 'ctrl') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (p === 'alt' || p === 'option') return IS_MAC ? '⌥' : 'Alt';
      if (p === 'enter' || p === 'return') return IS_MAC ? '↵' : 'Enter';
      if (p === 'escape' || p === 'esc') return 'Esc';
      return part.toUpperCase();
    })
    .join(IS_MAC ? '' : '+');
}
