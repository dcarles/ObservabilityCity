# Scripted events (the Konami code)

Type **up up down down left right left right B A** in the town (or open it with `?event` in the address) and the theme plays a short scripted
event on a patch of sea beside a random island. Escape ends it early; otherwise it ends by itself and the camera goes back.

| Theme | Event |
| --- | --- |
| harbour-town | **Pirate raid.** A ship moors at a jetty, pirates land and run to four buildings, the ship's cannon bombards them, and the crew carry gold, chests and rum back aboard before the ship sails off. |
| factory | **Zombie defence.** An armoured car races to a barricade, a horde charges it, fighters outside the barrier cut zombies down (and some fall and get up as zombies), gunners behind the barricade hold the line, and when it is quiet a giant comes and everyone opens fire on it. |
| space | **Alien invasion.** Saucers arrive and open fire, tractor beams drop aliens that walk the streets punching buildings, astronauts and survivors on the road shoot up at the saucers and at the aliens, and one saucer is hit and limps away. |

## How it is built

- `frontend/src/events/` holds it all. The town only knows `EventDirector` (`director.ts`) and `KonamiWatcher` (`konami.ts`), wired in `townMain.ts`.
- An event is a pure function of time: the same time always gives the same picture. The *story* (where everyone is, who shoots whom, when) is plain data (`zombieScript.ts`, `alienScript.ts`, `combat.ts`), so tests can check any moment. The *drawing* is in `pirates.ts`, `zombies.ts` and `aliens.ts`.
- `placement.ts` picks the spot: one of the outermost islands, on the side away from the middle of the town, clear of every island.
- Models live in `frontend/public/events/<theme event>/` as `.glb`. See `CREDITS.md` there for where they come from and their licence.
- To give a theme a different event, add a builder to `events/index.ts` and map the theme id in `EVENT_FOR_THEME`.

## What the tests prove

- `tests/unit/events.test.ts`: the Konami code, the theme-to-event mapping, placement clear of every island, the timeline, and the shooting schedule (a bullet lands exactly when its target falls, no gun fires faster than it can).
- `tests/unit/zombieScript.test.ts`: nothing stands on anything else at any moment of the zombie defence (props, armoured cars, people, buildings).
- `tests/unit/alienScript.test.ts`: aliens never walk through a building, nobody stands inside anybody, every alien falls to bullets.
- `tests/e2e/ui/events.spec.ts`: for each theme, the code starts the event beside an island with the town still drawn, time moves it on, it ends by itself or on Escape, and the code does nothing when typed into the search box.
