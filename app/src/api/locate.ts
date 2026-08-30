import { linkService, locateSupported, startLocating, stopLocating } from '../../modules/omarchy-link'
import type { ConnectClient } from './client'

/**
 * Find my phone, from the desktop end of the link.
 *
 * The phone is the only thing that knows where the phone is, and the only way
 * it can say so is by making a noise. So this is not really a feature of the
 * app at all: the desktop sends an instruction, the native `Locator` plays an
 * alarm loud enough to be heard through a sofa, and the app's whole job is to
 * carry the message and to answer honestly about what happened.
 *
 * Three things travel back, and the middle one is the point:
 *
 *   - **"It is ringing."** The desktop holds `omarchy-connect locate` open
 *     until this lands, so somebody about to walk into another room learns
 *     whether it is worth walking.
 *   - **"Somebody found it."** The button on the ringing screen is native and
 *     works with no runtime at all, but when there is one it reports back, and
 *     the bar panel stops offering to hush a phone already in a hand.
 *   - **"This phone cannot."** Expo Go and iOS have no alarm to play, and an
 *     honest refusal is better than a desktop believing it started something.
 *
 * There is nothing to switch on: a desktop asking where its own paired phone
 * is has already been trusted with far more than a noise, and a phone that
 * refused to answer would be one you could not find.
 */
export function startLocateResponder(client: ConnectClient): () => void {
  const native = linkService()

  const off = client.on('ev:phone', async (data: any) => {
    if (data?.action !== 'locate' || !data?.id) return
    const stop = data.op === 'stop'
    try {
      if (!locateSupported()) throw new Error('this phone cannot ring itself')
      if (stop) stopLocating()
      else startLocating(Number(data.seconds) || 60)
      await client.call('phone.located', { id: data.id, ok: true })
    } catch (err) {
      await client
        .call('phone.located', { id: data.id, ok: false, error: (err as Error).message })
        .catch(() => {})
    }
  })

  /**
   * The handset going quiet by hand. `found` carries no request id because
   * there is no request behind it — the desktop asked its question a minute
   * ago and this is a person answering it from the other room.
   */
  const nativeOff = native?.addListener('onLocateFound', () => {
    client.call('phone.located', { found: true }).catch(() => {})
  })

  // Deliberately leaves any noise running: a socket going away is not a
  // reason to stop shouting — the phone is still lost, and the search has a
  // clock of its own that ends it either way.
  return () => {
    off()
    nativeOff?.remove()
  }
}
