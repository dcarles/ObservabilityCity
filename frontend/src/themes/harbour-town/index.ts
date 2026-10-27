import { HARBOUR_LIGHTING } from '../../lighting'
import { harbourAirport } from './airport'
import type { ThemeKit } from '../types'
import { harbourPalette } from './palette'
import { harbourModel } from './models'
import { harbourVehicles } from './vehicles'
import { harbourBridge, harbourPier } from './links'

/** The default theme: islands on a sea, buildings by role, boats and cars. Built from the CC0 KayKit city pack and procedural geometry. */
export const harbourTown: ThemeKit = {
  id: 'harbour-town',
  palette: harbourPalette,
  lighting: HARBOUR_LIGHTING,
  buildModel: harbourModel,
  vehicles: harbourVehicles,
  bridge: harbourBridge,
  pier: harbourPier,
  airport: harbourAirport,
  roadTint: null,
  stars: false,
  prop: () => null,
}
