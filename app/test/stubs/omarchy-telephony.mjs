/**
 * A handset with no radio in it.
 *
 * `api/phone` asks for the native module and gets `null` on anything that is
 * not a phone, which is the shape a test runs in: call mirroring is simply
 * never started. Returning null here is not a stub of the feature, it is the
 * same answer the real module gives on a device without telephony.
 */
export function telephony() {
  return null
}

export const isTelephonyAvailable = () => false
