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

/* expo-file-system */
export class File {
  constructor(...parts) {
    this.uri = parts.join('/')
    this.exists = false
    this.size = 0
  }
  create() {}
  delete() {}
  write() {}
  text() {
    return ''
  }
}
export class Directory {
  constructor(...parts) {
    this.uri = parts.join('/')
    this.exists = false
  }
  create() {}
  list() {
    return []
  }
}
export const Paths = { cache: '/tmp', document: '/tmp' }

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
