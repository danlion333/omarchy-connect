package expo.modules.omarchylink

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build

/**
 * Both directions at once, without the phone hearing itself.
 *
 * `Mic` carries this phone's room to the desktop and `Speaker` carries the
 * desktop's sound back out of this phone, and each of them alone is a
 * convenience. Together, with nothing else done about it, they are a loop: the
 * loudspeaker plays what the desktop is saying, the microphone two centimetres
 * away picks it up, and the person at the desktop hears their own voice a
 * quarter of a second late. That is not a subtlety to be tuned away with a
 * gain — it is the reason speakerphones have echo cancellation.
 *
 * So this is a *mode* rather than a pair of switches, and it exists because
 * everything Android will do about the loop has to be decided before either
 * end is opened:
 *
 *   - **One audio session.** `AcousticEchoCanceler` is attached to a *record*
 *     session and subtracts what the platform knows is being played into that
 *     same session. A track opened on its own session is, as far as the
 *     canceller is concerned, another app's music — it cannot subtract it. So
 *     the record side is opened first, its session id is kept here, and the
 *     track joins it (`AudioTrack.Builder.setSessionId`).
 *   - **`VOICE_COMMUNICATION` rather than `VOICE_RECOGNITION`.** The
 *     unprocessed source `Mic` uses on its own is documented as the one *with
 *     no* platform processing, which is exactly what makes it the wrong source
 *     here: on most handsets the hardware canceller is only fitted to the
 *     communication path. `Mic` explains at length why the level is left to
 *     the desktop for a single microphone, and that argument is still right —
 *     it just does not survive a loudspeaker in the same room.
 *   - **`MODE_IN_COMMUNICATION`.** The canceller and the routing both hang off
 *     the audio manager's mode; a phone left in `MODE_NORMAL` gets a
 *     `VOICE_COMMUNICATION` input with nothing on the other side of it.
 *
 * ## Why the loudspeaker and not the earpiece
 *
 * `MODE_IN_COMMUNICATION` routes to the earpiece by default, which is what a
 * phone call wants and not what this wants: the case this is built for is a
 * handset lying on a desk being used as the desktop's speakerphone, and a
 * person is not going to hold it to their ear to hear their laptop. So the
 * built-in speaker is selected explicitly, which is also what makes the echo
 * real and the canceller worth having.
 *
 * ## What this promises, and what it does not
 *
 * `AcousticEchoCanceler.isAvailable()` is a per-handset answer and some phones
 * say no. This object says so — `status()` carries `aecAvailable` and
 * `aecEnabled` up to the desktop, which prints it — rather than pretending, and
 * rather than trying to write an echo canceller in Kotlin or in Node. A
 * duplex mode with no canceller still works for one person talking at a time;
 * it is the desktop's job to say that out loud, not this object's job to hide
 * it.
 *
 * Everything here is undone on the way out, and that matters more than usual:
 * a phone left in `MODE_IN_COMMUNICATION` with the communication device forced
 * to its speaker is a phone whose *own* calls and media come out wrong
 * afterwards, and nothing on screen would say why.
 */
internal object Headset {
  /** Is the phone meant to be a headset right now? Read by `Mic`/`Speaker`. */
  @Volatile
  var wanted = false
    private set

  /**
   * The record session the track has to join, or 0 when there is none yet.
   *
   * Zero is `AudioTrack`'s "give me a session of my own", which is the honest
   * answer while the microphone has not been opened: a track built before the
   * record side exists cannot join a session that has not been handed out.
   * The desktop opens the two in that order for exactly this reason.
   */
  @Volatile
  var sessionId = 0
    private set

  private var aec: AcousticEchoCanceler? = null
  private var aecAvailable = false
  private var aecEnabled = false

  /** The mode this phone was in before, so it can be put back in it. */
  private var priorMode = AudioManager.MODE_NORMAL
  private var manager: AudioManager? = null

  private fun audioManager(context: Context): AudioManager? =
    manager ?: (context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)

  /**
   * Enter the mode. Returns false only when this phone has no audio manager at
   * all, which is a device nothing else here would work on either.
   *
   * Idempotent: asking twice for a mode that is already on costs nothing, in
   * the same direction `Mic.start` and `Speaker.start` are idempotent.
   */
  fun start(context: Context): Boolean {
    if (wanted) return true
    val audio = audioManager(context) ?: run {
      Trace.warn("headset.start.refused", "reason" to "no-audio-manager")
      return false
    }
    manager = audio
    priorMode = try {
      audio.mode
    } catch (error: Exception) {
      AudioManager.MODE_NORMAL
    }
    // Set before anything is opened, because the mode is what decides which
    // input path a `VOICE_COMMUNICATION` record lands on.
    wanted = true
    try {
      audio.mode = AudioManager.MODE_IN_COMMUNICATION
    } catch (error: Exception) {
      // A phone that will not take the mode still gets the rest: the source
      // and the session are what the canceller really needs, and the routing
      // below is a preference rather than a requirement.
      Trace.warn("headset.mode.failed", "error" to error.javaClass.simpleName)
    }
    toSpeaker(audio)
    aecAvailable = try {
      AcousticEchoCanceler.isAvailable()
    } catch (error: Exception) {
      false
    }
    Trace.evt("headset.start", "aecAvailable" to aecAvailable, "priorMode" to priorMode)
    return true
  }

  /**
   * Leave the mode, and put the phone back the way it was found.
   *
   * Safe to call when the mode was never entered, and safe to call twice —
   * both happen, because the desktop asking, the socket dying and the app
   * being torn down are three roads to the same place and they race.
   */
  fun stop(context: Context?) {
    val audio = manager ?: context?.let { audioManager(it) }
    val was = wanted
    wanted = false
    unbind()
    if (audio != null) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          audio.clearCommunicationDevice()
        } else {
          @Suppress("DEPRECATION")
          audio.isSpeakerphoneOn = false
        }
      } catch (error: Exception) {
        Trace.warn("headset.route.restore.failed", "error" to error.javaClass.simpleName)
      }
      try {
        audio.mode = priorMode
      } catch (error: Exception) {
        Trace.warn("headset.mode.restore.failed", "error" to error.javaClass.simpleName)
      }
    }
    manager = null
    aecAvailable = false
    if (was) Trace.evt("headset.stop", "mode" to priorMode)
  }

  /**
   * The record side is open: hang the canceller on its session and remember
   * the session so the track can join it.
   *
   * Called by `Mic` immediately after `startRecording`, and only in this mode.
   */
  fun bind(session: Int) {
    if (!wanted) return
    sessionId = session
    if (!aecAvailable) {
      Trace.warn("headset.aec.unavailable", "session" to session)
      return
    }
    aec = try {
      AcousticEchoCanceler.create(session)
    } catch (error: Exception) {
      Trace.fail("headset.aec.failed", error)
      null
    }
    val effect = aec
    if (effect == null) {
      // Available on the platform and refused on this session: worth saying,
      // because it is the difference between "this phone cannot" and "this
      // stream did not get one".
      Trace.warn("headset.aec.refused", "session" to session)
      aecEnabled = false
      return
    }
    aecEnabled = try {
      effect.setEnabled(true)
      effect.enabled
    } catch (error: Exception) {
      Trace.warn("headset.aec.enable.failed", "error" to error.javaClass.simpleName)
      false
    }
    Trace.evt("headset.aec", "session" to session, "enabled" to aecEnabled)
  }

  /** The record side has gone. The canceller goes with it; the mode stays. */
  fun unbind() {
    val effect = aec
    aec = null
    sessionId = 0
    aecEnabled = false
    try {
      effect?.release()
    } catch (error: Exception) {
      /* the session it hung on is already gone */
    }
  }

  /** What the desktop is told, and prints, about this phone's duplex. */
  fun status(): Map<String, Any> = mapOf(
    "on" to wanted,
    "session" to sessionId,
    "aecAvailable" to aecAvailable,
    "aecEnabled" to aecEnabled,
    "recording" to Mic.isRunning,
    "playing" to Speaker.isRunning,
  )

  /**
   * Put the conversation on the loudspeaker rather than the earpiece.
   *
   * `setCommunicationDevice` is the API that replaced `isSpeakerphoneOn` in
   * Android 12 and it is the only one that works reliably alongside
   * `MODE_IN_COMMUNICATION` on newer handsets; the deprecated setter is kept
   * for anything older. Neither is fatal: a phone that ends up on its earpiece
   * is quiet, not broken.
   */
  private fun toSpeaker(audio: AudioManager) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val speaker = audio.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        }
        if (speaker != null) {
          val ok = audio.setCommunicationDevice(speaker)
          Trace.detail("headset.route", "speaker" to ok)
          return
        }
        Trace.warn("headset.route.missing")
      } else {
        @Suppress("DEPRECATION")
        audio.isSpeakerphoneOn = true
      }
    } catch (error: Exception) {
      Trace.warn("headset.route.failed", "error" to error.javaClass.simpleName)
    }
  }
}
