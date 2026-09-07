/**
 * The Expo modules `api/link` drags in behind it, reduced to their names.
 *
 * None of these has anything to do with a link to a desktop — they are the
 * battery gauge, the download directory, the photo library — but they are
 * imported at module scope by things `api/link` imports, and on Node they
 * reach a native module that is not there. Every export here is the smallest
 * shape its caller reads: enough to load, and inert if anything calls it.
 *
 * One file for all of them because the loader maps every `expo-*` specifier
 * it does not implement here, and an ESM stub has to name what it exports.
 */
const nothing = async () => null

/* expo-network */
export const getNetworkStateAsync = async () => ({ isConnected: true, type: 'WIFI' })
export const getIpAddressAsync = async () => '127.0.0.1'
export const NetworkStateType = { WIFI: 'WIFI', CELLULAR: 'CELLULAR', NONE: 'NONE' }
export const addNetworkStateListener = () => ({ remove() {} })

/* expo-battery */
export const getBatteryLevelAsync = async () => 1
export const getBatteryStateAsync = async () => 1
export const getPowerStateAsync = async () => ({ batteryLevel: 1, batteryState: 1, lowPowerMode: false })
export const isLowPowerModeEnabledAsync = async () => false
export const BatteryState = { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 }
export const addBatteryLevelListener = () => ({ remove() {} })
export const addBatteryStateListener = () => ({ remove() {} })
export const addLowPowerModeListener = () => ({ remove() {} })

/*
 * expo-file-system — a real file system, in a Map.
 *
 * It used to be four inert classes, which was enough for the modules that
 * merely import it. The clipboard history is written to a file and read back
 * on the next launch, and the only interesting question about it — does what
 * this process wrote come back to the next one — is a question about bytes
 * actually landing somewhere. So the stub keeps them, on `globalThis` where a
 * suite can survive re-importing the module and pretend to be a fresh launch.
 */
const files = (globalThis.__files ??= new Map())
const dirs = (globalThis.__dirs ??= new Set())

const at = (...parts) =>
  parts
    .map((part) => (part && typeof part === 'object' && 'uri' in part ? part.uri : String(part)))
    .join('/')
    .replace(/(?<!:)\/{2,}/g, '/')

export class File {
  constructor(...parts) {
    this.uri = at(...parts)
  }
  get exists() {
    return files.has(this.uri)
  }
  get size() {
    return files.get(this.uri)?.length ?? 0
  }
  create() {
    if (!files.has(this.uri)) files.set(this.uri, new Uint8Array(0))
  }
  write(content) {
    files.set(this.uri, typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content))
  }
  bytesSync() {
    const bytes = files.get(this.uri)
    if (!bytes) throw new Error(`no such file: ${this.uri}`)
    return bytes
  }
  async bytes() {
    return this.bytesSync()
  }
  textSync() {
    return new TextDecoder().decode(this.bytesSync())
  }
  async text() {
    return this.textSync()
  }
  delete() {
    files.delete(this.uri)
  }
}

export class Directory {
  constructor(...parts) {
    this.uri = at(...parts)
  }
  get exists() {
    return dirs.has(this.uri)
  }
  create() {
    dirs.add(this.uri)
  }
  delete() {
    dirs.delete(this.uri)
    for (const uri of [...files.keys()]) if (uri.startsWith(`${this.uri}/`)) files.delete(uri)
  }
  list() {
    return [...files.keys()].filter((uri) => uri.startsWith(`${this.uri}/`)).map((uri) => new File(uri))
  }
}

export const Paths = { cache: '/tmp/cache', document: '/tmp/document' }

/* expo-media-library */
export const Asset = { createAsync: nothing }
export const requestPermissionsAsync = async () => ({ granted: false })

/* expo-clipboard */
export const setStringAsync = nothing
export const getStringAsync = async () => ''
export const setImageAsync = nothing

/* expo-document-picker / expo-image-picker */
export const getDocumentAsync = async () => ({ canceled: true })
export const launchImageLibraryAsync = async () => ({ canceled: true })
export const launchCameraAsync = async () => ({ canceled: true })
export const requestMediaLibraryPermissionsAsync = async () => ({ granted: false })
export const requestCameraPermissionsAsync = async () => ({ granted: false })
export const MediaTypeOptions = { All: 'All', Images: 'Images', Videos: 'Videos' }

/*
 * expo-audio — the dictation recorder, as a switch and a count.
 *
 * `globalThis.__audio` is what a suite sets to describe the handset (whether
 * the recording permission is granted) and reads to find out what the
 * dictation road actually did: how often it asked, and what audio session it
 * left behind.
 */
const audio = (globalThis.__audio = { granted: false, asked: 0, modes: [] })

export const AudioModule = {
  requestRecordingPermissionsAsync: async () => {
    audio.asked += 1
    return { granted: audio.granted }
  },
}
export const RecordingPresets = { HIGH_QUALITY: {} }
export const setAudioModeAsync = async (mode) => {
  audio.modes.push(mode)
}
export const useAudioRecorder = () => ({
  prepareToRecordAsync: async () => {},
  record() {},
  async stop() {},
  uri: null,
})
