# Easter eggs (the Konami code)

Type **up up down down left right left right B A** in the town (or open it with `?event` in the address) and the theme plays a short scripted
event on a random island of the town, using that island's own buildings. Escape ends it early; otherwise it ends by itself and the camera goes back. It is for the 3D town only: the dashboard view never plays events.

The damage is only for show. Fire and scorch are drawn over the buildings in a group of their own, and nothing of the town is changed, so when the event ends the town is exactly as it was.

| Theme | Event |
| --- | --- |
| harbour-town | **Pirate raid.** A ship moors at a jetty, pirates land and run to four buildings, the ship's cannon bombards them, and the crew carry gold, chests and rum back aboard before the ship sails off. |
| factory | **Zombie defence.** An armoured car races to a barricade, a horde charges it, fighters outside the barrier cut zombies down (and some fall and get up as zombies), gunners behind the barricade hold the line, and when it is quiet a giant comes and everyone opens fire on it. |
| space | **Alien invasion.** Saucers arrive and open fire, tractor beams drop aliens that walk the streets punching buildings, astronauts and survivors on the road shoot up at the saucers and at the aliens, and one saucer is hit and limps away. |

## How it is built

- `frontend/src/events/` holds it all. The town only knows `EventDirector` (`director.ts`) and `KonamiWatcher` (`konami.ts`), wired in `townMain.ts`.
- An event is a pure function of time: the same time always gives the same picture. The *story* (where everyone is, who shoots whom, when) is plain data (`pirateScript.ts`, `zombieScript.ts`, `alienScript.ts`, `combat.ts`), so tests can check any moment. The *drawing* is in `pirates.ts`, `zombies.ts` and `aliens.ts`.
- `arena.ts` turns a real island (its coast, its buildings, the way out to sea) into ground the event can use: where people may stand, routes round the buildings, and which buildings to hit. `Town.eventSites()` hands it each island. `crowd.ts` delays anyone who would otherwise walk into someone else, and `ruin.ts` draws the fire and scorch.
- Models live in `frontend/public/events/<theme event>/` as `.glb`. See `CREDITS.md` there for where they come from and their licence.
- To give a theme a different event, add a builder to `events/index.ts` and map the theme id in `EVENT_FOR_THEME`.

## What the tests prove

- `tests/unit/events.test.ts`: the Konami code, the theme-to-event mapping, the timeline, and the shooting schedule (a bullet lands exactly when its target falls, no gun fires faster than it can).
- `tests/unit/arena.test.ts` and `crowd.test.ts`: routes go round buildings and obstacles; people who would meet are kept apart.
- `tests/unit/pirateScript.test.ts`: on five island shapes, the pirates reach doors of real buildings, never walk through one, and carry loot back before the ship leaves.
- `tests/unit/zombieScript.test.ts`: on the same five islands, nothing stands on anything else at any moment of the zombie defence (props, armoured cars, people, buildings).
- `tests/unit/alienScript.test.ts`: aliens never walk through a building, nobody stands inside anybody, every alien falls to bullets.
- `tests/e2e/ui/events.spec.ts`: for each theme, the code starts the event on a real island with the town still drawn, buildings get hit and the town is the same afterwards, time moves it on, it ends by itself or on Escape, the code does nothing when typed into the search box, and typing it in the dashboard view changes nothing.
