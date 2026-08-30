package expo.modules.omarchylink

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

/**
 * Making the handset findable from the desktop.
 *
 * The desktop cannot look under the sofa cushions, so the phone has to say
 * where it is, and the only vocabulary it has for that is noise. Everything
 * here follows from wanting that noise to happen in the one case the feature
 * exists for — a phone that has been face down and silent since yesterday:
 *
 *   - **The alarm stream, not the notification stream.** Silent mode and Do
 *     Not Disturb both mute notifications and neither mutes alarms, which is
 *     the whole reason an alarm clock is trusted. A "find my phone" that stays
 *     quiet on a phone left on silent would be one for the only phone nobody
 *     ever loses.
 *   - **Turned up on the way out, and put back after.** The stream is raised
 *     to maximum for the search and restored to whatever it was when the
 *     search ends, so tomorrow's alarm is not suddenly at full volume because
 *     somebody mislaid their phone once.
 *   - **A clock of its own.** The phone stops after the window it was given,
 *     whatever the desktop does next. A desktop that crashes mid-search, or a
 *     link that drops, must not leave a handset shouting in an empty house.
 *   - **One button, and it is on the phone.** Whoever finds it is holding it;
 *     what they want is silence, immediately, without unlocking anything.
 *
 * Stopping is reported back to the desktop through `onLocateFound`, so the
 * panel stops claiming the phone is ringing. There is no outbox behind that:
 * the search only ever starts on a live socket, and a runtime that dies
 * mid-search takes the report with it — but not the noise, which the handler
 * below ends regardless.
 */
object Locator {
  private const val CHANNEL = "omarchy-locate"

  /** One search at a time, so one notification that keeps replacing itself. */
  private const val KEY = "current"

  /** Long enough to be unmistakable, short enough to be interruptible. */
  private val PATTERN = longArrayOf(0, 800, 400)

  private val handler = Handler(Looper.getMainLooper())

  private var player: MediaPlayer? = null
  private var volumeBefore: Int? = null

  @Volatile
  var ringing = false
    private set

  /** Set while a module instance exists, so the desktop can be told. */
  @Volatile
  var onFound: (() -> Unit)? = null

  /**
   * Start shouting for `seconds`, or extend a search already under way.
   *
   * Idempotent on purpose: a second instruction from a desktop whose first one
   * went unanswered should reset the clock rather than stack a second player
   * on top of the first.
   */
  @Synchronized
  fun ring(context: Context, seconds: Int, desktop: String?) {
    val app = context.applicationContext
    handler.removeCallbacksAndMessages(null)
    ringing = true

    raiseAlarmVolume(app)
    startSound(app)
    startVibration(app)
    show(app, desktop)

    handler.postDelayed({ hush(app, found = false) }, seconds.coerceIn(5, 300) * 1000L)
  }

  /**
   * End the search. `found` is a person pressing the button on the handset —
   * the answer to the question the desktop asked — and is the one ending worth
   * telling the desktop about.
   */
  @Synchronized
  fun hush(context: Context, found: Boolean) {
    val app = context.applicationContext
    handler.removeCallbacksAndMessages(null)
    val wasRinging = ringing
    ringing = false

    try {
      player?.stop()
    } catch (error: Exception) {
      /* a player already stopped is not worth a crash */
    }
    try {
      player?.release()
    } catch (error: Exception) {
      /* same */
    }
    player = null

    vibrator(app)?.cancel()
    restoreAlarmVolume(app)
    Shade.cancel(app, Shade.LOCATE, KEY)

    if (found && wasRinging) {
      try {
        onFound?.invoke()
      } catch (error: Exception) {
        /* no runtime to tell; the desktop's own window expires on its own */
      }
    }
  }

  /* ── the noise ──────────────────────────────────────────────────────── */

  private fun startSound(context: Context) {
    val tone: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      ?: return
    try {
      player?.release()
      player = MediaPlayer().apply {
        setAudioAttributes(
          AudioAttributes.Builder()
            // USAGE_ALARM is what gets past silent mode and Do Not Disturb.
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        setDataSource(context, tone)
        isLooping = true
        prepare()
        start()
      }
    } catch (error: Exception) {
      // A tone that will not play leaves the vibration and the notification,
      // which on a phone under a cushion is still two thirds of the answer.
      player = null
    }
  }

  private fun startVibration(context: Context) {
    val vibrator = vibrator(context) ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // `repeat = 0` restarts the waveform from the top for as long as the
        // search lasts; `hush` is the only thing that ends it.
        vibrator.vibrate(VibrationEffect.createWaveform(PATTERN, 0))
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(PATTERN, 0)
      }
    } catch (error: Exception) {
      /* a phone that will not buzz still rings */
    }
  }

  private fun vibrator(context: Context): Vibrator? = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Vibrator::class.java)
    }
  } catch (error: Exception) {
    null
  }

  /**
   * Maximum for the search, and only for the search.
   *
   * The previous level is written down before the first change and not
   * overwritten by a second instruction arriving mid-search, so an extended
   * search still restores the volume the user actually chose.
   */
  private fun raiseAlarmVolume(context: Context) {
    val audio = context.getSystemService(AudioManager::class.java) ?: return
    try {
      if (volumeBefore == null) volumeBefore = audio.getStreamVolume(AudioManager.STREAM_ALARM)
      audio.setStreamVolume(
        AudioManager.STREAM_ALARM,
        audio.getStreamMaxVolume(AudioManager.STREAM_ALARM),
        0,
      )
    } catch (error: Exception) {
      // Some OEMs refuse this while a Do Not Disturb policy is active without
      // notification-policy access. The alarm still plays, at whatever level
      // the user left it.
    }
  }

  private fun restoreAlarmVolume(context: Context) {
    val previous = volumeBefore ?: return
    volumeBefore = null
    val audio = context.getSystemService(AudioManager::class.java) ?: return
    try {
      audio.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0)
    } catch (error: Exception) {
      /* nothing here is worth a crash */
    }
  }

  /* ── the card ───────────────────────────────────────────────────────── */

  /**
   * Its own channel, and a silent one: the sound and the buzz are played by
   * this object, on the alarm stream, and a channel that made its own noise
   * would put a second ringtone on top of them on the notification stream —
   * the stream silent mode mutes, which is exactly the one that must not be
   * relied on here.
   */
  private fun channel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = Shade.manager(context) ?: return
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(
      CHANNEL,
      "Finding this phone",
      NotificationManager.IMPORTANCE_HIGH,
    )
    channel.description = "When your desktop asks this phone to say where it is."
    channel.setSound(null, null)
    channel.enableVibration(false)
    manager.createNotificationChannel(channel)
  }

  private fun show(context: Context, desktop: String?) {
    channel(context)
    val stop = Shade.act(context, LinkActionReceiver.ACTION_FOUND, Shade.LOCATE, KEY)
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.omarchy_locate_notification)
      .setContentTitle("Found me?")
      .setContentText(desktop?.let { "$it is looking for this phone" } ?: "Your desktop is looking for this phone")
      // Tapping the card silences it too: somebody holding a shouting phone
      // wants it to stop, and making them find the right half of the card
      // first is a poor joke to play on them.
      .setContentIntent(stop)
      .setDeleteIntent(stop)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setSilent(true)
      .addAction(NotificationCompat.Action.Builder(R.drawable.omarchy_locate_notification, "Stop", stop).build())
    Shade.show(context, Shade.LOCATE, KEY, builder.build())
  }
}
