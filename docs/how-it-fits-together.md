# How it fits together

This page follows one piece of information from a YAML file on disk to a building on screen, and explains what .NET Aspire is doing in the middle. For the frontend side in more detail, see [frontend-stack.md](frontend-stack.md).

```
config/<town>/*.yaml  ->  registry loader  ->  sources poll  ->  snapshot builder  ->  SignalR             ->  browser
   (what to watch)         (checked, held)     (latest state)    (rules, every 2 s)    (on change, and      (Three.js)
                                                                                        at least every 15 s)
```

## What .NET Aspire does here

Aspire is a developer convenience, not part of the running app. `dotnet run --project backend/src/ObservabilityCity.AppHost` starts two things with one command:

- the **Host** (the ASP.NET Core backend: snapshot API and SignalR hub), and
- the **frontend** (the Vite dev server), told where the backend is so it can proxy `/api` and `/hubs` to it.

It also opens the Aspire dashboard (logs, traces and resource status in one place, http://localhost:15180), so there is no need to watch two terminals. The AppHost is a few lines in `backend/src/ObservabilityCity.AppHost/Program.cs`. Nothing in the Host or the frontend depends on it: the "Without Aspire" section of the README runs the same two processes by hand. It needs no Docker.

## From config to the screen

1. **Find the towns.** At start the Host looks for town folders. `Registry:Path` runs one folder. Without it, every `config/*/town.yaml` is a town, so a company that adds `config/acme` gets a town switcher without any setting (`Registry:Towns` adds folders by hand, `Registry:DefaultTown` picks the one a page opens on).
2. **Load and check the registry.** The registry loader reads the town, defaults, hub, third-parties, pillar and environment files (a leftover `layout.yaml` is refused), applies the defaults cascade (built-in values, then app defaults, then pillar, then system) and validates them. A pillar file with problems is skipped and drawn as a "config error" island instead of stopping the town.
3. **Watch the folder.** The folder is polled for changes every `Registry:WatchSeconds` (5 by default). A reload that works replaces the registry in use, a reload that fails keeps the last good one and says so in the notices panel. Sources, the town's mode and the adapters are set when the server starts, so changing those means a restart.
4. **Poll the sources.** Each environment has its own sources, built from what its file defines by the adapters found in the `adapters/` folder beside the program. A demo town (`mode: demo` in `town.yaml`) has only the fake source. Each source polls on its own timer and writes readings into a latest-state table. A source that fails goes stale on its own and does not stop the others. One that keeps failing is asked half as often from the second failed round and a quarter as often from the third (never less often than every five minutes, unless its own interval is longer), and goes back to its interval when a round works. The Aspire log says so once when it starts failing, every five minutes while it stays down, and once when it is back, with how long it was down.
5. **Build a snapshot.** Every `Snapshot:IntervalSeconds` (2 by default) the snapshot builder joins the registry with the latest readings and applies the rules, for example that stale is never green and that down beats degraded. The result is one `Snapshot` per environment of each town. Viewers are sent it when something in it changed (its clock fields aside) and at least every `Snapshot:KeepAliveSeconds` (15 by default), so a source read once a minute does not cause a new snapshot every two seconds.
6. **Push it.** The SignalR hub (`/hubs/town`) sends each snapshot to the browsers watching that town and environment (`?town=` and `?env=` in the address). `GET /api/snapshot/latest` returns the same snapshot over plain HTTP.
7. **Draw it.** The TypeScript app receives the snapshot, sets building colours, lights, floors and beacons from its numbers, and invents all the motion (cars, boats, weather) from the rates in it. The browser never knows which source produced a number, which is why real adapters can replace the fake one without touching the town.

## Where a company's own parts plug in

The core knows only generic concepts (groups, systems, resources, links) and is cloud-neutral: the Azure adapter ships today, and other clouds and tools plug in through adapters. A company adds its town folder under `config/` and its own adapters under `extensions/`, and never edits the core. See [connect-your-company.md](connect-your-company.md) and [write-an-adapter.md](write-an-adapter.md).
