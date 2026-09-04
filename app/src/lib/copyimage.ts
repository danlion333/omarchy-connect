/**
 * Copying a picture the desktop sent onto this phone's clipboard.
 *
 * Two steps, and either can fail for a reason worth reading: the bytes have to
 * be here — an offer is a token until somebody downloads it — and the phone
 * has to accept them, which some OEM builds simply do not. Both cases used to
 * be the same nothing: a row that did not react.
 *
 * Pure and away from both callers so that the wording, the order and the
 * single download can be tested without a phone. The shade's own **Copy** does
 * the same two steps in Kotlin, where the bytes were fetched before the card
 * was drawn and there is nothing left to download.
 */

export type PictureClip = { token: string; name: string }

/** The sentence a throw carried, or something honest when it carried none. */
const reason = (error: unknown) => {
  const message = (error as Error)?.message
  return message && message.trim() ? message.trim() : 'the phone refused it'
}

/**
 * Fetches the picture if it is not here yet, then puts it on the clipboard.
 *
 * Answers with the line to show, and throws with the line to show — the caller
 * has one place for each and no decision to make about which.
 */
export async function copyPicture(
  picture: PictureClip,
  deps: {
    fetch: (token: string, name: string) => Promise<string>
    copy: (uri: string) => unknown
  },
): Promise<string> {
  let uri: string
  try {
    uri = await deps.fetch(picture.token, picture.name)
  } catch (error) {
    throw new Error(`${picture.name} did not reach this phone — ${reason(error)}`)
  }
  if (!uri) throw new Error(`${picture.name} did not reach this phone`)
  try {
    deps.copy(uri)
  } catch (error) {
    throw new Error(`the phone would not take the picture — ${reason(error)}`)
  }
  return 'copied to the phone clipboard'
}
