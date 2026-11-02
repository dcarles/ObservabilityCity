import { browserStore } from './lighting'
import { startView } from './viewMode'

// The page opens in one of two views. Each is loaded on its own, so the dashboard never downloads three.js.
const view = startView(window.location.search, browserStore())
if (view === 'dashboard') void import('./dashboard/dashboard').then((m) => m.startDashboard())
else void import('./townMain').then((m) => m.startTown())
