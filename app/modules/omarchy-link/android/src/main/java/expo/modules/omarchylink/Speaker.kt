package expo.modules.omarchylink

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The desktop's sound, out of this phone's speaker.
 *
 * `Mic` is this object's mirror and the whole road was built in that direction
 * first: the phone speaks, the desktop listens. Nothing in this repository has
 * ever played a byte that came off the socket — the only playback in the app is
 * `Locator`, which plays a ringtone file through `MediaPlayer` and touches no
 * link at all. So this is `AudioTrack`, which is `AudioRecord`'s twin and the
 * only class on Android that plays PCM as it arrives rather than a file that
 * has finished arriving.
 *
 * Deliberately dumb, in the same way. It opens one track at one format, takes
 * whole chunks from whoever calls `write`, and does no decoding, no
 * resampling, no mixing and no buffering of its own beyond the track's. The
 * bytes are 16 kHz mono `s16le` because that is what the channel carries in
 * both directions (`daemon/src/lib/speaker.js` explains why that and not
 * 48 kHz stereo), and a chunk that arrives with no track open is dropped by
 * the layer above rather than stored by this one.
 *
 * ## Why `MUSIC` and not `VOICE_COMMUNICATION`
 *
 * The usage a track declares is what decides which physical output Android
 * routes it to, which volume slider changes it, and whether it ducks. The sink
 * on the other end carries *everything on that desktop* — a meeting, an album,
 * a notification — so there is no one right answer and `USAGE_MEDIA` is the
 * honest default: it lands on the loudspeaker, follows the media volume the
 * person already knows, and mixes with rather than interrupts whatever else is
 * making noise. `VOICE_COMMUNICATION` would route to the earpiece and enable
 * the phone's call-audio processing over sound that has already been through a
 * desktop's mixer, which is the wrong thing done twice.
 *
 * ## Why the foreground service type matters here
 *
 * From Android 14 a foreground service that plays has to declare the
 * `mediaPlayback` type, and it has to declare it *before* the track is
 * written to — otherwise the system stops the playback the moment the app is
 * no longer visible, which is the entire case this feature exists for. It is
 * the same claim `Mic` makes for `microphone`, added to the service that
 * already exists rather than in a second service, and dropped again the moment
 * the track is given back. `LinkService.holdPlayback` is that.
 *
 * ## What is not here
 *
 * No wake lock, for the reason `Mic` holds none: `AudioTrack` keeps the CPU
 * awake while it is playing, which is exactly the window that needs it.
 *
 * No queue either. A chunk that could not be written to the track is a chunk
 * that arrived faster than the phone can play, and the answer to that is to
 * let it go — the desktop is fifty chunks ahead by the time anybody could have
 * decided otherwise. `write` is non-blocking for exactly that reason: a
 * blocking write here would push the socket's own read loop behind real time
 * and never catch up.
 */
internal object Speaker {
  /** The one format. Matches `daemon/src/lib/speaker.js` byte for byte. */
  const val RATE = 16000
  private const val CHANNEL = AudioFormat.CHANNEL_OUT_MONO
  private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
  private const val BYTES_PER_SAMPLE = 2

  /** Bounds on what a caller may ask for a chunk to be. */
  private const val MIN_CHUNK_MS = 20
  private const val MAX_CHUNK_MS = 1000

  /** Playing ended without being asked to. Empty reason means it was asked. */
  @Volatile
  var onStopped: ((String) -> Unit)? = null

  private val running = AtomicBoolean(false)
  private var track: AudioTrack? = null

  val isRunning: Boolean
    get() = running.get()

  /**
   * Open the track and start accepting chunks. Returns false when it could
   * not, which the module turns into the sentence the desktop prints.
   *
   * Idempotent in the only direction that matters: a second start while one is
   * playing answers true rather than costing the desktop the track it has.
   */
  fun start(context: Context, rate: Int, chunkMs: Int): Boolean {
    if (running.get()) return true
    val window = chunkMs.coerceIn(MIN_CHUNK_MS, MAX_CHUNK_MS)
    val hz = if (rate > 0) rate else RATE
    val chunkBytes = hz * BYTES_PER_SAMPLE * window / 1000

    // The type has to be held before anything is played, not after: what
    // Android 14 checks is whether the service was already allowed to play at
    // the moment the track starts.
    LinkService.holdPlayback(true)

    val minimum = AudioTrack.getMinBufferSize(hz, CHANNEL, ENCODING)
    if (minimum <= 0) {
      Trace.warn("speaker.start.refused", "reason" to "no-buffer-size", "code" to minimum)
      LinkService.holdPlayback(false)
      return false
    }
    // Eight chunks of slack — 160 ms at the wire's twenty. More than `Mic`
    // keeps, and for a reason that only applies in this direction: what feeds
    // this track is a Wi-Fi hop, and a chunk that lands late has nothing else
    // standing in front of it. The desktop's ring is *ahead* of the network
    // here rather than behind it (`daemon/src/lib/pipesink.js`), so this
    // buffer is the only thing between a jittery link and a hole in the sound.
    val bufferBytes = maxOf(minimum, chunkBytes * 8)

    // Headset mode changes both halves of what a track declares, and neither
    // can be changed afterwards — which is why the mode is entered before
    // anything is opened. `USAGE_VOICE_COMMUNICATION` is what puts this sound
    // on the path the platform's echo canceller knows about, and the session
    // is the microphone's own, so what comes out of the speaker is what the
    // canceller subtracts from what goes into the microphone. Outside the
    // mode this is `USAGE_MEDIA` on a session of its own, for every reason
    // argued above.
    val duplex = Headset.wanted
    val session = Headset.sessionId

    val output = try {
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(if (duplex) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
            .setContentType(if (duplex) AudioAttributes.CONTENT_TYPE_SPEECH else AudioAttributes.CONTENT_TYPE_MUSIC)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(ENCODING)
            .setSampleRate(hz)
            .setChannelMask(CHANNEL)
            .build(),
        )
        .setBufferSizeInBytes(bufferBytes)
        // Stream mode rather than static: there is no end to this sound and
        // no buffer that holds all of it, which is the whole difference
        // between this and the ringtone `Locator` plays.
        .setTransferMode(AudioTrack.MODE_STREAM)
        // Zero is Android's own "a session of my own", so a headset mode whose
        // microphone has not opened yet gets exactly what it would have got
        // before — a working track with no canceller behind it — rather than
        // a refused build.
        .apply { if (duplex && session > 0) setSessionId(session) }
        .build()
    } catch (error: Exception) {
      Trace.fail("speaker.start.failed", error)
      LinkService.holdPlayback(false)
      return false
    }
    if (output.state != AudioTrack.STATE_INITIALIZED) {
      Trace.warn("speaker.start.refused", "reason" to "uninitialised", "state" to output.state)
      try {
        output.release()
      } catch (error: Exception) {
        /* nothing to release that was ever initialised */
      }
      LinkService.holdPlayback(false)
      return false
    }

    track = output
    running.set(true)
    try {
      output.play()
    } catch (error: Exception) {
      Trace.fail("speaker.start.play.failed", error)
      running.set(false)
      track = null
      try {
        output.release()
      } catch (ignored: Exception) {
        /* already gone */
      }
      LinkService.holdPlayback(false)
      return false
    }

    Trace.evt(
      "speaker.start",
      "rate" to hz,
      "chunkMs" to window,
      "buffer" to bufferBytes,
      "headset" to duplex,
      "session" to session,
    )
    return true
  }

  /**
   * One chunk into the track. False means the sound has nowhere to go and the
   * layer above should tell the desktop so.
   *
   * `WRITE_NON_BLOCKING`, and the short write it can produce is *not* retried:
   * a full track means chunks are arriving faster than they can be played, and
   * the tail of one is worth less than the whole of the next. What is dropped
   * is counted in the log rather than queued, which is the same bargain the
   * desktop makes about its own pipe.
   */
  fun write(pcm: ByteArray): Boolean {
    if (!running.get()) return false
    val output = track ?: return false
    return try {
      val wrote = output.write(pcm, 0, pcm.size, AudioTrack.WRITE_NON_BLOCKING)
      if (wrote < 0) {
        // ERROR_INVALID_OPERATION and ERROR_DEAD_OBJECT both mean the track is
        // gone — the device changed, or Android reclaimed it.
        Trace.warn("speaker.write.failed", "code" to wrote)
        val reason = "the phone stopped playing (code $wrote)"
        stop()
        onStopped?.invoke(reason)
        false
      } else {
        if (wrote < pcm.size) Trace.detail("speaker.write.short", "wrote" to wrote, "of" to pcm.size)
        true
      }
    } catch (error: Exception) {
      Trace.fail("speaker.write.threw", error)
      val reason = error.message ?: error.javaClass.simpleName
      stop()
      onStopped?.invoke(reason)
      false
    }
  }

  /**
   * Give the track back.
   *
   * Safe to call when nothing is playing, and safe to call twice — both
   * happen, because the desktop asking for a stop and the socket dying are two
   * different roads to the same place and they race.
   *
   * `pause` and `flush` before `stop`, deliberately: `stop()` on its own drains
   * whatever is left in the buffer first, so a track told to stop plays a
   * hundred milliseconds of yesterday's sound into a room where the person has
   * already switched the speaker off.
   */
  fun stop() {
    if (!running.getAndSet(false)) return
    val output = track
    track = null
    try {
      output?.pause()
      output?.flush()
    } catch (error: Exception) {
      /* it was already stopped, or was never started */
    }
    try {
      output?.stop()
    } catch (error: Exception) {
      /* the same */
    }
    try {
      output?.release()
    } catch (error: Exception) {
      /* the same */
    }
    LinkService.holdPlayback(false)
    Trace.evt("speaker.stop")
  }

  /** The whole point of the base64: bytes across the bridge, as `Mic` does. */
  fun writeEncoded(encoded: String): Boolean {
    val bytes = try {
      Base64.decode(encoded, Base64.NO_WRAP)
    } catch (error: Exception) {
      Trace.warn("speaker.decode.failed", "error" to error.javaClass.simpleName)
      return false
    }
    return write(bytes)
  }
}
