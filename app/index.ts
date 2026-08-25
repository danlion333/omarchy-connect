import { registerRootComponent } from 'expo'
import { getRandomBytes } from 'expo-crypto'

import App from './App'
import { setRandomSource } from './src/api/crypto'

// The encrypted channel needs a CSPRNG before the first socket opens, and the
// only one guaranteed to exist on both platforms is the native module's.
setRandomSource(getRandomBytes)

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App)
