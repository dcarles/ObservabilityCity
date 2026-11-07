// The column titles of a pillar's table stay under the menu while the table scrolls, and leave with it: they stop once the top of the pillar's last
// service row reaches them. The stuck position itself is CSS (position: sticky); this only works out how far to lift them at the end of the table.

/** How far (px, zero or negative) to lift the titles: none while the last row is still below them, then up with the row. */
export function headShift(menuHeight: number, headHeight: number, lastRowTop: number): number {
  return Math.min(0, lastRowTop - (menuHeight + headHeight))
}

/** Lifts the titles of every service table under `root`. Cheap enough to call on each scroll frame. */
export function fitHeads(root: ParentNode, menuHeight: number): void {
  root.querySelectorAll<HTMLTableElement>('table.svc').forEach((table) => {
    const cells = table.querySelectorAll<HTMLElement>('thead th')
    const rows = table.querySelectorAll<HTMLElement>('tbody tr.row')
    const last = rows[rows.length - 1]
    if (cells.length === 0 || !last) return
    const shift = headShift(menuHeight, cells[0]!.offsetHeight, last.getBoundingClientRect().top)
    cells.forEach((c) => { c.style.transform = shift ? `translateY(${shift}px)` : '' })
  })
}
