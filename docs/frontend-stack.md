# The frontend stack, explained simply

The frontend lives in `frontend/`. It is plain TypeScript and Three.js, built and served by Vite, and it gets its data from the .NET backend over SignalR. There is no UI framework such as React.

```
C# backend  ->  SignalR  ->  TypeScript code  ->  Three.js scene + HTML panels
```

## Three.js draws the town

Three.js is the most widely used WebGL library, with the biggest community and the most examples. It gives full control over the scene, which a town with animated boats, cars and weather needs. Babylon.js is the main alternative. It is more of a game engine and heavier, and would only pay off with physics or a built-in editor.

## Why no React

Almost the whole screen is one 3D canvas redrawn about 60 times a second. React is built for pages of forms, lists and buttons that change now and then, and it adds nothing inside a canvas. Using it there means react-three-fiber, a second layer of concepts on top of Three.js. The drawer, legend and panels around the town are small, so plain TypeScript fills in ordinary HTML for them.

If the UI around the town ever grows into a real app (many settings screens, lots of forms), adding React for just those parts would be a reasonable move later.

## Vite is the build tool, not a framework

React, Vue and Angular decide how you write the UI. Vite sits at a different level: it takes your code (TypeScript, imports, CSS) and serves it to the browser while you develop, reloading the page on every save. For a release it bundles everything into a few small files. The closest .NET comparison is `dotnet build` plus `dotnet watch`, while React or Vue would be like choosing MVC or Blazor.

Vite only matters while developing. Once the app is built, it is not running. In dev it also proxies `/api` and `/hubs` to the .NET host (see `frontend/vite.config.ts`).

## Vite versus SignalR

They refresh two different things:

- **Vite** reloads the page when the *code* changes.
- **SignalR** pushes *data* while the app runs. The backend builds a snapshot of the town's health and pushes it to every open browser over one live connection. The town updates without a page reload.

## How the browser talks to the backend

- **Live connection:** the Microsoft SignalR client for JavaScript (`@microsoft/signalr`) opens the connection to the hub at `/hubs/town`, and the backend pushes each new snapshot down it. If the socket cannot be opened (a proxy in the way, say), `src/connection.ts` polls the same snapshot over plain HTTP instead.
- **Plain requests:** the first snapshot and similar calls use the browser's built-in `fetch`.
- **TypeScript:** the whole frontend is written in it. Browsers only run JavaScript, so Vite strips the types out when it serves or builds the code.
- **Keeping both sides in step:** the C# `Snapshot` records are the source of truth. The backend publishes their shape as `contracts/openapi.json`, and `npm run gen:contracts` generates `frontend/src/contracts.ts` from it. If a C# field is renamed, the frontend stops compiling until it is updated. `npm run check:contracts` fails the build if the committed files have drifted.
- **Drawing:** the TypeScript code takes each snapshot and updates the Three.js scene (floors, lights, beacons, cars). The browser invents all motion from the numbers in the snapshot and never knows which source produced them.

## Tests

Vitest runs the unit tests (`frontend/tests/unit`) and Playwright runs the browser tests (`frontend/tests/e2e`). See the Tests section of the main README.
