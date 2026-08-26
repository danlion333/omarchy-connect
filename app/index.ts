import { registerRootComponent } from 'expo'
import { getRandomBytes } from 'expo-crypto'
import { AppRegistry } from 'react-native'

import App from './App'
import { setRandomSource } from './src/api/crypto'
import { link } from './src/api/link'

// The encrypted channel needs a CSPRNG before the first socket opens, and the
// only one guaranteed to exist on both platforms is the native module's.
setRandomSource(getRandomBytes)

/**
 * The link, running without a screen.
 *
 * React Native suspends every timer the moment the activity pauses — the
 * keepalive ping, the reconnect backoff, the telephony flush — and a headless
 * task is the one thing that tells it not to. So the task holds a promise that
 * never settles: its lifetime is the connection's lifetime, and the foreground
 * service in `modules/omarchy-link` ends it by finishing the task.
 *
 * This is also the entry point on a cold start. When the service comes up
 * after a reboot there is no activity and no component tree, so `link.start()`
 * here is what dials the desktop; `start` is idempotent, so the app opening
 * afterwards joins the same connection rather than opening a second one.
 */
AppRegistry.registerHeadlessTask('OmarchyConnectLink', () => async () => {
  // Ending the task is what suspends the timers, so a start that fails is
  // retried inside it rather than thrown out of it. Failing at all is rare and
  // means the pairing could not be read — a phone that has not been unlocked
  // since it booted — so the retry is slow on purpose. Once the client exists
  // its own backoff owns every later failure.
  while (true) {
    try {
      await link.start()
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30_000))
    }
  }
  await new Promise<void>(() => {})
})

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App)
