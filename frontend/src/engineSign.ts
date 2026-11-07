// What a database building's own sign says: the engine it runs on, with its type underneath. A database that names no engine keeps the
// generic word of its theme, so nothing changes for it.

/** The engine a database building shows. */
export interface EngineLabel {
  name: string
  typeName: string
}

/** What a model is built with. A broker's port sign reads `name`, a database's sign reads `engine`. */
export interface ModelOptions {
  tenanted?: boolean
  name?: string
  engine?: EngineLabel | null
}

const MAX = 14

/** The engine's name in capitals, short enough for the board. */
export function engineSignTitle(engine: EngineLabel): string {
  const text = engine.name.trim().toUpperCase()
  return text.length <= MAX ? text : `${text.slice(0, MAX - 1).trimEnd()}…`
}

/** The sign's words: the engine in capitals and the type under it, or null when the database names no engine. */
export function engineSignText(engine?: EngineLabel | null): { title: string; sub: string } | null {
  if (!engine || engine.name.trim() === '') return null
  return { title: engineSignTitle(engine), sub: engine.typeName }
}

/** Paints a 512x128 database sign: the island's colour with the engine and its type, or the theme's generic word when there is no engine. */
export function paintDatabaseSign(ctx: CanvasRenderingContext2D, accent: string, generic: string, genericSize: number, engine?: EngineLabel | null): void {
  ctx.fillStyle = accent; ctx.fillRect(0, 0, 512, 128)
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  const text = engineSignText(engine)
  if (!text) {
    ctx.font = `800 ${genericSize}px system-ui, sans-serif`
    ctx.fillText(generic, 256, 68)
    return
  }
  ctx.font = '800 68px system-ui, sans-serif'
  ctx.fillText(text.title, 256, 48, 480)
  ctx.font = '700 40px system-ui, sans-serif'
  ctx.fillText(text.sub, 256, 100, 480)
}

/** The words on a database's sign as one line, for tests and the model: undefined when it keeps the generic word. */
export function databaseSignText(engine?: EngineLabel | null): string | undefined {
  const text = engineSignText(engine)
  return text ? `${text.title} · ${text.sub}` : undefined
}
