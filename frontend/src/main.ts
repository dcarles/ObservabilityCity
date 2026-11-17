import { browserStore } from './lighting'
import { startView } from './viewMode'

// The page opens in one of three views. Each is loaded on its own, so the dashboard and the diagram never download three.js.
const view = startView(window.location.search, browserStore())
if (view === 'dashboard') void import('./dashboard/dashboard').then((m) => m.startDashboard())
else if (view === 'architecture') void Promise.all([import('./dashboard/dashboard'), import('./architecture/page')]).then(([d, a]) => d.startDashboard(a.architecturePlug()))
else void import('./townMain').then((m) => m.startTown())
