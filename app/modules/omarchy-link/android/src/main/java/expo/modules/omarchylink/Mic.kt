package expo.modules.omarchylink

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import android.os.Process
import android.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone's microphone, as a stream rather than as a file.
 *
 * Everything this app records today goes through `expo-audio`, which is the
 * right tool for what it does: press, speak, release, and a finished `.m4a`
 * appears with a URI. What it cannot do is hand over the sound *while it is
 * still happening* — there is no buffer callback anywhere in its surface — and
 * "while it is still happening" is the entire difference between dictation and
 * a microphone. So this is `AudioRecord`, which is the layer underneath, and
 * the only one on Android that gives out samples as they arrive.
 *
 * Deliberately dumb. It opens one input at one format, reads it on one thread,
 * and hands whole chunks to whoever set `onChunk`. It does no encoding, no
 * resampling, no voice detection and no buffering across a broken link: the
 * bytes are 16 kHz mono `s16le` because that is what the desktop's whisper
 * pipeline already resamples everything to, and a chunk that has nowhere to go
 * is dropped by the layer above rather than stored by this one. Sound that
 * missed its moment is not worth keeping.
 *
 * ## Why the foreground service type matters here
 *
 * From Android 14 a foreground service that uses the microphone has to say so
 * — `foregroundServiceType="microphone"` — or the system stops the capture the
 * moment the app is no longer visible. `LinkService` was already a foreground
 * service for the socket's sake, so what this adds is a second type on the one
 * that exists rather than a second service. `LinkService.holdMicrophone` is
 * that, and it is asked *before* the input is opened, because the ordering is
 * the whole of what the system checks.
 *
 * ## What is not here
 *
 * No wake lock. The link deliberately holds none (see `LinkService`), and a
 * recording is not a reason to change that: `AudioRecord` keeps the CPU awake
 * for as long as it is reading, which is exactly the window that needs it, and
 * a lock held around it would only extend into the part where nothing is
 * happening.
 */
internal object Mic {
  /** The one format. Matches `daemon/src/lib/mic.js` byte for byte. */
  const val RATE = 16000
  private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
  private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
  private const val BYTES_PER_SAMPLE = 2

  /** Bounds on what a caller may ask for a chunk to be. */
  private const val MIN_CHUNK_MS = 20
  private const val MAX_CHUNK_MS = 1000

  /** One chunk of sound, base64 because that is how bytes cross the bridge. */
  @Volatile
  var onChunk: ((String, Int) -> Unit)? = null

  /** Recording ended without being asked to. Empty reason means it was asked. */
  @Volatile
  var onStopped: ((String) -> Unit)? = null

  private val running = AtomicBoolean(false)
  private var recorder: AudioRecord? = null
  private var thread: Thread? = null

  /**
   * Wi-Fi held out of power save while the microphone streams.
   *
   * Measured from the desktop with this phone on Wi-Fi: chunks leave every
   * 20 ms and mostly land 20 ms apart, but a few times a minute one lands
   * 100–190 ms late, and on the desktop that gap is exactly the dropout a
   * program hears — the PipeWire source keeps a ring of a fixed few dozen
   * milliseconds and a chunk that misses it is silence
   * (`daemon/src/lib/pipesource.js`). Power save is the usual reason a
   * station sits on its frames. `WIFI_MODE_FULL_LOW_LATENCY` is the mode
   * Android names for exactly this, and when the app is not in front it falls
   * back to keeping the radio fully awake, which is the case a phone in a
   * pocket is in. Held only while recording, because that is the only time it
   * earns its battery.
   */
  private var wifi: WifiManager.WifiLock? = null

  val isRunning: Boolean
    get() = running.get()

  fun hasPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  /**
   * Open the input and start emitting chunks. Returns false when it could not,
   * which the module turns into the sentence the desktop prints.
   *
   * Idempotent in the only direction that matters: a second start while one is
   * running is a no-op that answers true, because the desktop asking twice for
   * something it already has should not cost it the stream it has.
   */
  fun start(context: Context, chunkMs: Int): Boolean {
    if (running.get()) return true
    if (!hasPermission(context)) {
      Trace.warn("mic.start.refused", "reason" to "no-permission")
      return false
    }
    val window = chunkMs.coerceIn(MIN_CHUNK_MS, MAX_CHUNK_MS)
    val chunkBytes = RATE * BYTES_PER_SAMPLE * window / 1000

    // The type has to be held before the input is opened, not after: what
    // Android 14 checks is whether the service was already allowed to use a
    // microphone at the moment the capture starts.
    LinkService.holdMicrophone(true)

    val minimum = AudioRecord.getMinBufferSize(RATE, CHANNEL, ENCODING)
    if (minimum <= 0) {
      Trace.warn("mic.start.refused", "reason" to "no-buffer-size", "code" to minimum)
      LinkService.holdMicrophone(false)
      return false
    }
    // Four chunks of slack. The reader is a dedicated thread doing nothing but
    // reading, so this is not about throughput — it is about the tens of
    // milliseconds Android occasionally takes the thread away for.
    val bufferBytes = maxOf(minimum, chunkBytes * 4)

    // Headset mode is decided here rather than passed in, because the two
    // things that decide it — the source and the session — are both fixed at
    // the moment the input is constructed and cannot be changed on a running
    // `AudioRecord`. `Headset` explains why it is a mode and not a switch.
    val duplex = Headset.wanted
    val source =
      if (duplex) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION

    val input = try {
      // VOICE_RECOGNITION rather than MIC: it is the source Android documents
      // as unprocessed for speech — no automatic gain riding over pauses, no
      // noise suppression tuned for a phone call.
      //
      // Nothing about dictation depends on this. Dictation records through
      // `expo-audio` into an `.m4a` and uploads the file (`app/src/api/
      // dictate.ts`); it never touches this stream. What depends on it is the
      // desktop's live input, and it wants unprocessed for a different reason
      // than a transcriber would: measured on this desk, the untouched signal
      // has a noise floor around -71 dBFS against the USB webcam's -51 dBFS,
      // so the desktop can add twenty decibels to it and still be quieter in
      // the gaps than the device it is being compared to. The level is put
      // right on the desktop, once, where it can be turned off — see
      // `Leveller` in `daemon/src/lib/mic.js`. An `AutomaticGainControl`
      // fitted here would spend that headroom before the desktop ever saw
      // it, differently on every handset, and could not be undone from the
      // machine that has to live with the result.
      //
      // In headset mode all of that is still true and none of it is decisive.
      // The desktop's sound is coming out of this phone's own loudspeaker two
      // centimetres from this microphone, so the thing to be got right is not
      // the noise floor but the loop, and the loop is only cancellable on the
      // communication path — `VOICE_COMMUNICATION`, one audio session, an
      // `AcousticEchoCanceler` bound below. The platform's own gain riding
      // comes with it and cannot be turned off from here; that is the price of
      // not hearing yourself, and `Headset` argues it at length.
      AudioRecord(source, RATE, CHANNEL, ENCODING, bufferBytes)
    } catch (error: Exception) {
      Trace.fail("mic.start.failed", error)
      LinkService.holdMicrophone(false)
      return false
    }
    if (input.state != AudioRecord.STATE_INITIALIZED) {
      Trace.warn("mic.start.refused", "reason" to "uninitialised", "state" to input.state)
      try {
        input.release()
      } catch (error: Exception) {
        /* nothing to release that was ever initialised */
      }
      LinkService.holdMicrophone(false)
      return false
    }

    recorder = input
    running.set(true)
    try {
      input.startRecording()
    } catch (error: Exception) {
      Trace.fail("mic.start.recording.failed", error)
      running.set(false)
      recorder = null
      try {
        input.release()
      } catch (ignored: Exception) {
        /* already gone */
      }
      LinkService.holdMicrophone(false)
      return false
    }

    // After `startRecording` and not before: the session id is real from the
    // moment the object exists, but an effect created on a session that is not
    // yet capturing is one more thing to get wrong for no gain. The track
    // joins this session afterwards, which is why the desktop opens the
    // microphone first.
    if (duplex) Headset.bind(input.audioSessionId)

    wifi = try {
      (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
        ?.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "omarchy:mic")
        ?.also {
          it.setReferenceCounted(false)
          it.acquire()
        }
    } catch (error: Exception) {
      // A phone without Wi-Fi, or one that refuses: the stream still runs,
      // it just keeps whatever latency the radio gives it.
      Trace.warn("mic.wifi.lock.failed", "error" to error.javaClass.simpleName)
      null
    }

    Trace.evt(
      "mic.start",
      "chunkMs" to window,
      "buffer" to bufferBytes,
      "wifiLock" to (wifi != null),
      "headset" to duplex,
      "session" to input.audioSessionId,
    )
    thread = Thread({ pump(input, chunkBytes) }, "omarchy-mic").also {
      it.priority = Thread.MAX_PRIORITY
      it.start()
    }
    return true
  }

  /**
   * Give the microphone back.
   *
   * Safe to call when nothing is recording, and safe to call twice — both
   * happen, because the desktop asking for a stop and the socket dying are two
   * different roads to the same place and they race.
   */
  fun stop() {
    if (!running.getAndSet(false)) return
    val input = recorder
    recorder = null
    try {
      input?.stop()
    } catch (error: Exception) {
      /* it was already stopped, or was never started */
    }
    try {
      input?.release()
    } catch (error: Exception) {
      /* the same */
    }
    thread = null
    // The canceller hangs on the session this input just gave back, so it goes
    // with it. The *mode* does not: the desktop's sound may still be playing
    // out of this phone, and leaving it is a decision made a layer up.
    Headset.unbind()
    try {
      wifi?.takeIf { it.isHeld }?.release()
    } catch (error: Exception) {
      /* the radio is not ours to argue with */
    }
    wifi = null
    LinkService.holdMicrophone(false)
    Trace.evt("mic.stop")
  }

  /**
   * The read loop. One chunk out per `chunkBytes` read, counted from zero so
   * the desktop can see a hole rather than a splice.
   *
   * `read` is blocking and returns short: it hands back whatever the buffer
   * had, so a chunk is assembled from as many reads as it takes rather than
   * assumed to arrive whole. Getting that wrong is the classic way to produce
   * audio that plays at the wrong speed with clicks in it.
   */
  private fun pump(input: AudioRecord, chunkBytes: Int) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val chunk = ByteArray(chunkBytes)
    var filled = 0
    var seq = 0
    var reason = ""
    try {
      while (running.get()) {
        val read = input.read(chunk, filled, chunkBytes - filled)
        if (read <= 0) {
          // ERROR_INVALID_OPERATION and ERROR_DEAD_OBJECT both mean the input
          // is gone — the permission was revoked, or another app took it.
          if (read < 0) {
            reason = "the phone stopped recording (code $read)"
            Trace.warn("mic.read.failed", "code" to read)
            break
          }
          continue
        }
        filled += read
        if (filled < chunkBytes) continue
        val encoded = Base64.encodeToString(chunk, 0, filled, Base64.NO_WRAP)
        filled = 0
        val sink = onChunk
        if (sink == null) {
          // Nobody to send to. Not an error and not worth recording into
          // nowhere either — the layer above stops on its own the moment its
          // socket goes, and this is only the window before it notices.
          seq += 1
          continue
        }
        try {
          sink(encoded, seq)
        } catch (error: Exception) {
          Trace.warn("mic.chunk.failed", "error" to error.javaClass.simpleName)
        }
        seq += 1
      }
    } catch (error: Exception) {
      reason = error.message ?: error.javaClass.simpleName
      Trace.fail("mic.pump.failed", error)
    }
    // Whatever ended the loop, the input goes back. `stop` is idempotent, so
    // the ordinary case — somebody called it and the loop noticed — costs
    // nothing here.
    val unasked = running.get()
    stop()
    if (unasked) onStopped?.invoke(reason.ifEmpty { "the phone stopped recording" })
  }
}
