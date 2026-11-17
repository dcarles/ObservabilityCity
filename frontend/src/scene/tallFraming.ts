// Where the camera stands to look at a tall building, or at an island with tall buildings on it. Pure, so it is tested without a renderer.

/** The tallest a building could stand when the camera was first set up (about 8 floors); a taller one moves the camera. */
export const TALL_FROM = 18
/** A building looked at from its usual 46 units away, aimed at 2 units above the ground. */
export const BUILDING_DISTANCE = 46
const BUILDING_AIM = 2
/** For each unit of height above TALL_FROM, how much higher the camera looks (at the middle of the tower) and how much further back it stands. */
const TALL_LOOK_UP = 0.95
const TALL_STAND_BACK = 3.7
/** The same for a whole island, which is framed from further away already. */
const ISLAND_LOOK_UP = 0.4
const ISLAND_STAND_BACK = 1.2

/**
 * How to look at one building `height` units tall. A building no taller than TALL_FROM is framed as it always was; a taller one is looked at higher up
 * (`aim`, the height of the point that ends up in the middle of the screen) and from further back, so its roof stays on the screen.
 */
export function buildingFraming(height: number): { aim: number; distance: number; tall: boolean } {
  const over = Math.max(0, height - TALL_FROM)
  return { aim: BUILDING_AIM + over * TALL_LOOK_UP, distance: BUILDING_DISTANCE + over * TALL_STAND_BACK, tall: over > 0 }
}

/** How to look at an island whose usual stand-off is `distance` and whose tallest building is `tallest` units high: the same idea, for a whole island. */
export function islandFraming(tallest: number, distance: number): { aim: number; distance: number } {
  const over = Math.max(0, tallest - TALL_FROM)
  return { aim: over * ISLAND_LOOK_UP, distance: distance + over * ISLAND_STAND_BACK }
}
