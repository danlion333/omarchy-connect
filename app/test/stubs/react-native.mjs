/**
 * Just enough React Native for a module that only wants to know whether the
 * app is in front of somebody.
 *
 * `api/alerts` reaches for `AppState` and nothing else, and the real package
 * cannot be loaded outside a native runtime — so this is the whole of it. The
 * state is writable from the test: a phone in a pocket is the case the alerts
 * exist for, so that is the default.
 */
export const AppState = {
  currentState: 'background',
  addEventListener: () => ({ remove() {} }),
}
