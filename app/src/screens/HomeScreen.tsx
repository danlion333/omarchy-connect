import React from 'react'

import { DashboardScreen } from './DashboardScreen'

/**
 * Workspace 1: the desktop at a glance.
 *
 * Home is where the Stats and Remote tabs are going: what the machine is
 * doing, what is on its screens, and the handful of controls that change it.
 * Until that merge lands this is the dashboard as it was, under its own
 * screen file so the shell already points at the right place.
 */
export function HomeScreen() {
  return <DashboardScreen />
}
