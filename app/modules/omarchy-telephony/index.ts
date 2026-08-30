import { requireNativeModule, NativeModule } from 'expo'
import { Platform } from 'react-native'

export type SmsEvent = {
  kind: 'sms'
  at: number
  from: string | null
  name: string | null
  body: string
  read?: boolean
}

export type CallEvent = {
  kind: 'call'
  at: number
  /**
   * One conversation's token. Ringing, answered and over are three broadcasts
   * about the same call, and this is what lets the desktop keep them to one
   * line. Absent on entries read back from the log, which are already one row
   * per call.
   */
  call?: string | null
  /** Live state from the broadcast; absent on entries read back from the log. */
  state?: 'ringing' | 'active' | 'ended'
  /**
   * When the talking started, off the dialler's own call timer.
   *
   * Android tells an app the line went off-hook, which on a call this phone
   * placed is the moment of dialling, and never tells it the far end picked
   * up. Without this the desktop counts the ringing into the conversation and
   * runs a ring cycle ahead of the timer on the handset's screen. Null when
   * the dialler's card is not showing a clock to read.
   */
  startedAt?: number | null
  from: string | null
  name: string | null
  missed: boolean
  seconds?: number
  direction?: 'incoming' | 'outgoing' | 'missed' | null
}

export type TelephonyEvent = SmsEvent | CallEvent

export type PermissionResult = {
  status: 'granted' | 'denied' | 'undetermined'
  granted: boolean
  canAskAgain: boolean
}

type Events = {
  onMessage: (event: SmsEvent) => void
  onCall: (event: CallEvent) => void
}

declare class OmarchyTelephony extends NativeModule<Events> {
  isAvailable(): boolean
  getPermissionsAsync(): Promise<PermissionResult>
  requestPermissionsAsync(): Promise<PermissionResult>
  requestSendPermissionAsync(): Promise<PermissionResult>
  requestCallPermissionAsync(): Promise<PermissionResult>
  /** Whether ANSWER_PHONE_CALLS is held right now — cheap, so not a promise. */
  canAnswerCalls(): boolean
  /**
   * Whether the dialler's notifications can be read — which is the only place
   * a modern Android puts the caller's name where an app can see it.
   */
  canReadCallNotifications(): boolean
  canReadContacts(): boolean
  /** Opens the system screen where notification access is granted. */
  openNotificationAccess(): Promise<void>
  answerCall(): Promise<{ ok: boolean; audio: 'handset' }>
  rejectCall(): Promise<{ ok: boolean }>
  drainBacklog(): Promise<TelephonyEvent[]>
  backlogSize(): number
  recentMessages(limit: number): Promise<SmsEvent[]>
  recentCalls(limit: number): Promise<CallEvent[]>
  sendMessage(to: string, text: string): Promise<{ ok: boolean; to: string; parts: number }>
}

/**
 * Android only, and only in a real build.
 *
 * Expo Go cannot carry the SMS and call-log permissions, and iOS does not
 * expose either to any app — so the module is simply absent on both, and every
 * caller has to cope with `null` rather than being handed a stub that lies.
 */
let cached: OmarchyTelephony | null | undefined

export function telephony(): OmarchyTelephony | null {
  if (cached !== undefined) return cached
  if (Platform.OS !== 'android') {
    cached = null
    return cached
  }
  try {
    cached = requireNativeModule<OmarchyTelephony>('OmarchyTelephony')
  } catch {
    cached = null
  }
  return cached
}

export const isTelephonyAvailable = () => telephony() !== null
