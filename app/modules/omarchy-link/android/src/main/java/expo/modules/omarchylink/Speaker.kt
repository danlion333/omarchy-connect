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
 * Deliberately dumb, in the same way. It opens one track at the format the
 * desktop and this phone agreed on, takes whole chunks from whoever calls
 * `write`, and does no decoding, no resampling, no mixing and no buffering of
 * its own beyond the track's. A chunk that arrives with no track open is
 * dropped by the layer above rather than stored by this one.
 *
 * ## The format is a parameter, and the answer says which one was got
 *
 * There are two: the baseline, 16 kHz mono, which is what this road carried
 * for its whole life and what an old build of this app is the only thing
 * that can open; and 48 kHz stereo, which is what a desktop's own output
 * actually is and what `daemon/src/lib/speaker.js` offers by default. Both
 * are `ENCODING_PCM_16BIT`; what changes is the sample rate and the channel
 * mask, and neither can be changed on a track that has been built.
 *
 * `start` therefore returns what it opened rather than a bare true, because
 * the two differ in two situations and both are silent failures if the
 * desktop is not told. Headset mode forces the baseline — that track is on a
 * voice session behind the platform's echo canceller, which works at 16 kHz
 * mono, and `Headset.kt` is out of this change's scope on purpose. And
 * `AudioTrack.getMinBufferSize` refuses some rate and mask combinations on
 * some hardware with no list anywhere of which; the caller retries at the
 * baseline, and what it must not do is report a format the track was not
 * built at. A desktop sending 48 kHz stereo into a 16 kHz mono track is not
 * quieter or slower — it is noise at three times the speed.
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
  /** The baseline, and the fallback for everything. `daemon/src/lib/speaker.js`'s. */
  const val RATE = 16000
  const val CHANNELS = 1
  private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
  private const val BYTES_PER_SAMPLE = 2

  /** Every rate the desktop may name. Anything else is the baseline. */
  private val RATES = intArrayOf(16000, 48000)

  /** The mask for a channel count, and mono for anything this does not know. */
  private fun maskFor(channels: Int) =
    if (channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO

  /** Bounds on what a caller may ask for a chunk to be. */
  private const val MIN_CHUNK_MS = 20
  private const val MAX_CHUNK_MS = 1000

  /**
   * How many chunks of slack the track is opened with.
   *
   * Sixteen rather than the eight this started with — 320 ms at the wire's
   * twenty rather than 160. The number is not a preference: what feeds this
   * track is a Wi-Fi hop, and the jitter tail measured on that hop is 150 to
   * 190 ms. A 160 ms buffer is *under* the tail, so the ordinary worst case
   * of a phone on a home network is a track that runs dry — which is heard as
   * a click and a hole, not as a late chunk. Nothing else on this road absorbs
   * it: the desktop's `module-pipe-tunnel` ring stands *ahead* of the network
   * rather than behind it (`daemon/src/lib/pipesink.js`), so its 171 ms is
   * latency this direction has already spent, not slack it can draw on.
   *
   * The price is 160 ms more delay between a program playing on the desktop
   * and the sound leaving the handset, and it is the right trade for what this
   * road is for — a meeting, an album, a phone on the table across the room.
   * It would be the wrong one for anything with a picture attached, and if
   * that ever arrives it wants its own number rather than this one lowered.
   */
  private const val BUFFER_CHUNKS = 16

  /**
   * How often the counters below are put in the log while sound is playing.
   *
   * Ten seconds, because the question they answer — "is this link losing
   * sound, and where" — is asked of a minute of playback, not of one chunk.
   * A line per short write was the old behaviour and it is useless twice
   * over: it is off unless somebody turned the tag up, and at fifty chunks a
   * second a link in trouble writes faster than anybody can read.
   */
  private const val SUMMARY_MS = 10_000L

  /** Playing ended without being asked to. Empty reason means it was asked. */
  @Volatile
  var onStopped: ((String) -> Unit)? = null

  private val running = AtomicBoolean(false)
  private var track: AudioTrack? = null

  /** The format the open track was built at, for a second `start` to answer with. */
  @Volatile
  private var current: Map<String, Any>? = null

  /**
   * What one chunk of the agreed format is, so the tail below can be bounded
   * in sound rather than in bytes. Set when the track is opened.
   */
  private var chunkBytes = 0

  /**
   * The end of a chunk the track had no room for.
   *
   * Not a queue — a queue is the thing this file argues against at length and
   * still does not have. It is at most one chunk, it is written before the
   * next chunk and never after it, and it exists because a *partial* write is
   * not the same event as a full track: the samples the track took and the
   * samples it did not are one continuous piece of sound, and throwing the
   * second half away puts a 5 ms hole in the middle of a chunk that otherwise
   * arrived intact. Twenty milliseconds late and whole beats on time with a
   * bite out of it, and the bytes are already on the phone either way.
   *
   * What is still refused is a *backlog*: once the tail is a chunk long the
   * track has not been keeping up for a whole chunk's worth of time, and the
   * oldest of it is dropped — counted, in `droppedBytes` — rather than
   * carried further into the future.
   */
  private var tail: ByteArray = ByteArray(0)

  /* The counters behind `evt=speaker`. Written only from the socket's own
   * thread, which is the only thread that calls `write`. */
  private var wrote = 0
  private var shortWrites = 0
  private var carriedBytes = 0
  private var droppedBytes = 0
  private var summaryAt = 0L

  val isRunning: Boolean
    get() = running.get()

  /**
   * Open the track and start accepting chunks. Returns false when it could
   * not, which the module turns into the sentence the desktop prints.
   *
   * Idempotent in the only direction that matters: a second start while one is
   * playing answers true rather than costing the desktop the track it has.
   */
  fun start(context: Context, rate: Int, channels: Int, chunkMs: Int): Map<String, Any> {
    val window = chunkMs.coerceIn(MIN_CHUNK_MS, MAX_CHUNK_MS)
    // Headset mode is the one caller whose format is not the desktop's to
    // choose: that track joins the microphone's session behind the platform's
    // echo canceller, which is a 16 kHz mono thing, and a stereo track on it
    // would either be refused or cancel nothing. The answer says so rather
    // than the desktop finding out from the sound.
    val duplex = Headset.wanted
    val hz = if (duplex || !RATES.contains(rate)) RATE else rate
    val lanes = if (duplex || channels != 2) CHANNELS else 2
    val opened: Map<String, Any> = mapOf("ok" to true, "rate" to hz, "channels" to lanes)
    /** Nothing was built. The layer above turns this into a sentence, or a retry. */
    val refused: Map<String, Any> = mapOf("ok" to false)
    // A second start while one is playing answers with the track that exists
    // rather than with the one that was asked for — it is the running track
    // the desktop's chunks are going into, and saying otherwise would have it
    // send a format nothing here can play.
    if (running.get()) return current ?: opened
    val channel = maskFor(lanes)
    val chunkBytes = hz * lanes * BYTES_PER_SAMPLE * window / 1000
    this.chunkBytes = chunkBytes
    tail = ByteArray(0)
    wrote = 0
    shortWrites = 0
    carriedBytes = 0
    droppedBytes = 0
    summaryAt = System.currentTimeMillis()

    // The type has to be held before anything is played, not after: what
    // Android 14 checks is whether the service was already allowed to play at
    // the moment the track starts.
    LinkService.holdPlayback(true)

    val minimum = AudioTrack.getMinBufferSize(hz, channel, ENCODING)
    if (minimum <= 0) {
      Trace.warn("speaker.start.refused", "reason" to "no-buffer-size", "code" to minimum, "rate" to hz, "channels" to lanes)
      LinkService.holdPlayback(false)
      return refused
    }
    // Slack against the Wi-Fi hop that feeds this track, and the only slack
    // there is: see `BUFFER_CHUNKS` for why it is sixteen of them and not the
    // eight this started with.
    val bufferBytes = maxOf(minimum, chunkBytes * BUFFER_CHUNKS)

    // Headset mode changes both halves of what a track declares, and neither
    // can be changed afterwards — which is why the mode is entered before
    // anything is opened, and why `hz` and `lanes` above are already the
    // baseline by the time this is read. `USAGE_VOICE_COMMUNICATION` is what puts this sound
    // on the path the platform's echo canceller knows about, and the session
    // is the microphone's own, so what comes out of the speaker is what the
    // canceller subtracts from what goes into the microphone. Outside the
    // mode this is `USAGE_MEDIA` on a session of its own, for every reason
    // argued above.
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
            .setChannelMask(channel)
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
      return refused
    }
    if (output.state != AudioTrack.STATE_INITIALIZED) {
      Trace.warn("speaker.start.refused", "reason" to "uninitialised", "state" to output.state, "rate" to hz, "channels" to lanes)
      try {
        output.release()
      } catch (error: Exception) {
        /* nothing to release that was ever initialised */
      }
      LinkService.holdPlayback(false)
      return refused
    }

    track = output
    current = opened
    running.set(true)
    try {
      output.play()
    } catch (error: Exception) {
      Trace.fail("speaker.start.play.failed", error)
      running.set(false)
      track = null
      current = null
      try {
        output.release()
      } catch (ignored: Exception) {
        /* already gone */
      }
      LinkService.holdPlayback(false)
      return refused
    }

    // `state` is in the line because the one thing a desktop cannot see from
    // its end is whether the track it asked for was actually built: a refusal
    // is `speaker.start.refused` and this is its opposite, and both name the
    // rate and the channel count they happened at.
    Trace.evt(
      "speaker.start",
      "rate" to hz,
      "channels" to lanes,
      "state" to output.state,
      "chunkMs" to window,
      "buffer" to bufferBytes,
      "bufferMs" to (bufferBytes.toLong() * 1000 / (hz * lanes * BYTES_PER_SAMPLE)),
      "headset" to duplex,
      "session" to session,
    )
    return opened
  }

  /**
   * One chunk into the track. False means the sound has nowhere to go and the
   * layer above should tell the desktop so.
   *
   * `WRITE_NON_BLOCKING`, because a blocking write here would push the
   * socket's own read loop behind real time and never catch it up. What that
   * costs is short writes — the track takes the first part of a chunk and
   * refuses the rest — and the part it refused is *not* thrown away: it is
   * held in `tail` and written in front of the next chunk, which is the whole
   * of the sound in the right order, at most one chunk late. See `tail` for
   * where that stops being true and the oldest of it is dropped instead.
   *
   * Whatever is lost here is counted and put in the log as one `evt=speaker`
   * line every ten seconds, not as a line per chunk: fifty chunks a second is
   * faster than anybody reads, and the question is how much of a minute of
   * playback went missing rather than which chunk it was.
   */
  fun write(pcm: ByteArray): Boolean {
    if (!running.get()) return false
    val output = track ?: return false
    // The tail goes first — it is older sound than what has just arrived, and
    // out of order it would be worse than lost.
    val payload = if (tail.isEmpty()) pcm else tail + pcm
    tail = ByteArray(0)
    return try {
      var at = 0
      while (at < payload.size) {
        val took = output.write(payload, at, payload.size - at, AudioTrack.WRITE_NON_BLOCKING)
        if (took < 0) {
          // ERROR_INVALID_OPERATION and ERROR_DEAD_OBJECT both mean the track
          // is gone — the device changed, or Android reclaimed it.
          Trace.warn("speaker.write.failed", "code" to took)
          val reason = "the phone stopped playing (code $took)"
          stop()
          onStopped?.invoke(reason)
          return false
        }
        at += took
        // Nothing moved: the track is full, and the loop would spin on it.
        // What is left is the tail, and this is where the chunk ends.
        if (took == 0) break
      }
      wrote += 1
      if (at < payload.size) {
        shortWrites += 1
        var rest = payload.copyOfRange(at, payload.size)
        // A tail longer than one chunk is a track that has not kept up for a
        // whole chunk's worth of time; carrying it further would only play it
        // later still. The oldest goes, which is the same bargain the desktop
        // makes at `MAX_BACKLOG_MS`.
        if (chunkBytes > 0 && rest.size > chunkBytes) {
          droppedBytes += rest.size - chunkBytes
          rest = rest.copyOfRange(rest.size - chunkBytes, rest.size)
        }
        carriedBytes += rest.size
        tail = rest
      }
      summarise(false)
      true
    } catch (error: Exception) {
      Trace.fail("speaker.write.threw", error)
      val reason = error.message ?: error.javaClass.simpleName
      stop()
      onStopped?.invoke(reason)
      false
    }
  }

  /**
   * The counters, in one line, every `SUMMARY_MS` of playback and once more
   * when the track is given back.
   *
   * `chunks` is what arrived, `short` how many of them the track could not
   * take whole, `carried` how many bytes were finished on the next write and
   * `dropped` how many were given up on — so a minute of playback answers, on
   * its own, whether this phone was the place the sound went missing. The
   * desktop's own three numbers (`sent`, `missed`, `dropped`) answer the same
   * question for the other end of the road.
   */
  private fun summarise(force: Boolean) {
    val now = System.currentTimeMillis()
    if (!force && now - summaryAt < SUMMARY_MS) return
    val seconds = (now - summaryAt) / 1000
    summaryAt = now
    Trace.evt(
      "speaker",
      "chunks" to wrote,
      "short" to shortWrites,
      "carried" to carriedBytes,
      "dropped" to droppedBytes,
      "held" to tail.size,
      "sec" to seconds,
    )
    wrote = 0
    shortWrites = 0
    carriedBytes = 0
    droppedBytes = 0
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
    current = null
    // Last, and whatever the clock says: a run shorter than one summary
    // window is the run somebody was listening to when it broke.
    summarise(true)
    tail = ByteArray(0)
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
