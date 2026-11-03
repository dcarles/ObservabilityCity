/** The two paints of every boat, in every theme, the way the cars have two: blue for the boats that sail between islands, yellow for the boats that loop round their own island. */
export const BOAT_PAINT = {
  between: { body: '#2f6fd0', trim: '#1b438c' },
  internal: { body: '#f2c230', trim: '#a87d0c' },
} as const

export const boatPaint = (internal: boolean) => (internal ? BOAT_PAINT.internal : BOAT_PAINT.between)
