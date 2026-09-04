package expo.modules.omarchylink

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
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

    val input = try {
      // VOICE_RECOGNITION rather than MIC: it is the source Android documents
      // as unprocessed for speech — no automatic gain riding over pauses, no
      // noise suppression tuned for a phone call — which is what a
      // transcriber and a remote listener both want.
      AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, CHANNEL, ENCODING, bufferBytes)
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

    Trace.evt("mic.start", "chunkMs" to window, "buffer" to bufferBytes)
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
