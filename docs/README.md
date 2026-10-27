# Observability City: plan

Planning material for Observability City, a browser app that shows system health as a living 3D town. The code lives beside it. Phase 1 is built slice by slice (see the plan and the decision log).

| File | What it is |
|---|---|
| [observability-city-plan.md](observability-city-plan.md) | **The plan.** Summary, visual language, architecture, registry config, Phase 1 decisions and build order, roadmap, risks. Exported from the [Claude Doc](https://claude.ai/artifact/9GzxXsugoyXUQ8NoVc5Rou) on 24 Oct 2026 |
| [frontend-stack.md](frontend-stack.md) | **The frontend stack, explained simply.** Why Three.js, why no React, what Vite and SignalR each do, and how the .NET backend reaches the browser |
| [how-it-fits-together.md](how-it-fits-together.md) | **How it fits together.** What Aspire does, and the path from the config files to the town on screen |
| [decision-log.md](decision-log.md) | How each decision was reached, with extra detail. If it disagrees with the plan, the plan wins |
| [previews/](previews/) | Throwaway three.js sketches used to make the visual decisions. Open in a browser (they load three.js from a CDN). Not the final art |
| [previews/screenshots/](previews/screenshots/) | Still images of each preview option |

Previews:
1. `1-art-style-and-lighting.html`: Dusk, Day and Toon. Decision: Day by default with a Dusk toggle, no Toon.
2. `2-island-shapes.html`: island shapes. Decision: organic coastlines with square plots and streets (A1).
3. `3-ui-layout.html`: UI layout. Decision: A, inspector drawer on the right.
