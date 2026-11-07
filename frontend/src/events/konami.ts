// The Konami code: up up down down left right left right B A. Typing it in the town starts the event for the theme.

export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'] as const

/** Follows the keys typed and says when the code has just been completed. Any run of keys that ends with the code counts, so a stray extra Up before it does no harm. */
export class KonamiWatcher {
  private typed: string[] = []
  /** Feed every key press. Returns true on the press that completes the code. */
  push(key: string): boolean {
    this.typed.push(key.length === 1 ? key.toLowerCase() : key)
    if (this.typed.length > KONAMI.length) this.typed.shift()
    const done = this.typed.length === KONAMI.length && KONAMI.every((k, i) => k === this.typed[i])
    if (done) this.typed = []
    return done
  }
}

/** True for a key press that belongs to someone typing into a box, which must never count. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  const tag = el?.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el?.isContentEditable
}
