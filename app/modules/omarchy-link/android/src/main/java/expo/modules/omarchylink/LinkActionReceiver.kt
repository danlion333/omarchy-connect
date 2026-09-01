package expo.modules.omarchylink

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/**
 * The buttons on this app's notifications, and what they do without a screen.
 *
 * A receiver gets about ten seconds and no guarantee that a React runtime
 * exists at all, so the work divides in two:
 *
 *   - **What Android can do by itself** — putting text on the clipboard —
 *     happens here and now, and needs neither the socket nor the app.
 *   - **Everything else** is written to `Outbox` first, then the service is
 *     asked for, then whoever is already listening is told. That order is what
 *     makes an answer typed at three in the morning survive a process that
 *     dies on the next line.
 */
class LinkActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_REPLY = "expo.modules.omarchylink.REPLY"
    const val ACTION_SAVE = "expo.modules.omarchylink.SAVE"
    const val ACTION_COPY = "expo.modules.omarchylink.COPY"
    const val ACTION_DISMISS = "expo.modules.omarchylink.DISMISS"
    const val ACTION_RECONNECT = "expo.modules.omarchylink.RECONNECT"
    const val ACTION_FOUND = "expo.modules.omarchylink.FOUND"
    const val EXTRA_KIND = "kind"
    const val EXTRA_KEY = "key"
    const val EXTRA_TEXT = "text"

    /** Set while a module instance is alive, so events can reach the app. */
    @Volatile
    var listener: ((String, Map<String, Any?>) -> Unit)? = null

    private fun emit(event: String, payload: Map<String, Any?>) {
      val target = listener
      if (target == null) {
        // Not an error — the outbox is the whole plan for this case — but the
        // difference between "nobody was listening" and "somebody was and it
        // threw" is the difference between two very different bugs.
        Trace.detail("emit.parked", "event" to event)
        return
      }
      try {
        target.invoke(event, payload)
        Trace.detail("emit", "event" to event)
      } catch (error: Exception) {
        /* the runtime went away between the broadcast and the send */
        Trace.warn("emit.failed", "event" to event, "error" to error.javaClass.simpleName)
      }
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    val key = intent.getStringExtra(EXTRA_KEY)
    Trace.evt("action", "name" to intent.action?.substringAfterLast('.'), "key" to Trace.mark(key))
    when (intent.action) {
      ACTION_REPLY -> reply(context, intent, key ?: return)
      ACTION_SAVE -> save(context, intent, key ?: return)
      ACTION_COPY -> copy(context, intent)
      ACTION_DISMISS -> {
        val kind = intent.getStringExtra(EXTRA_KIND) ?: return
        Shade.cancel(context, kind, key ?: return)
      }
      /**
       * Somebody is holding the phone the desktop was looking for. This one
       * needs no runtime and no socket: the noise is native, so stopping it is
       * native too, and the desktop is told afterwards if there is anything
       * left alive to tell it.
       */
      ACTION_FOUND -> Locator.hush(context, found = true)
      ACTION_RECONNECT -> {
        LinkPrefs.setStatus(context, "connecting")
        // The tap is what un-parks the link: JavaScript is told to dial
        // regardless of what Android says about the network, so the shade
        // should stop saying it is waiting before the socket confirms it.
        LinkPrefs.setWaiting(context, false)
        LinkService.refresh(context)
        wake(context)
        emit("onLinkReconnect", emptyMap())
      }
    }
  }

  private fun reply(context: Context, intent: Intent, session: String) {
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(AgentAlerts.REPLY_KEY)?.toString()?.trim()
    if (text.isNullOrEmpty()) {
      Trace.detail("reply.empty", "session" to Trace.mark(session))
      return
    }

    // Written down before anything else: from here on the answer is safe even
    // if this process is killed on the next line.
    Outbox.add(context, "reply", session, text)
    // The length and not the words: an answer typed into a notification is as
    // private as anything this app carries.
    Trace.evt("reply.queued", "session" to Trace.mark(session), "chars" to Trace.len(text))
    // The shade should stop offering a text box for an answer already given.
    AgentAlerts.note(context, session, "sending: $text", LinkPrefs.desktop(context))
    wake(context)
    emit("onOutbox", emptyMap())
  }

  private fun save(context: Context, intent: Intent, token: String) {
    val name = intent.getStringExtra(EXTRA_TEXT) ?: return
    // Fetching the bytes needs the socket's credentials and the media library,
    // so this is the JavaScript side's job — the receiver only records that it
    // was asked for.
    Outbox.add(context, "save", token, name)
    Trace.evt("save.queued", "token" to Trace.mark(token))
    DesktopAlerts.fileNote(context, token, name, "saving to your gallery…")
    wake(context)
    emit("onOutbox", emptyMap())
  }

  /**
   * The one action that needs nothing else running.
   *
   * Android restricts *reading* another app's clipboard in the background;
   * writing is allowed, which is the direction this goes. From Android 13 the
   * system draws its own confirmation, so the notification is only rewritten
   * for the versions that do not.
   */
  private fun copy(context: Context, intent: Intent) {
    val text = intent.getStringExtra(EXTRA_TEXT) ?: return
    try {
      val manager = context.getSystemService(ClipboardManager::class.java) ?: return
      manager.setPrimaryClip(ClipData.newPlainText("Omarchy Connect", text))
      Trace.evt("clipboard.write", "chars" to Trace.len(text))
      DesktopAlerts.clipboardCopied(context, text)
    } catch (error: Exception) {
      /* an OEM that refuses this is not worth a crash in a receiver */
      Trace.fail("clipboard.write.failed", error)
    }
  }

  /**
   * Makes sure something is running that can carry the work out.
   *
   * A user who switched the background link off has said they do not want the
   * service, and answering one notification is not consent to it running all
   * day — so this starts nothing in that case. The work keeps in the outbox
   * and goes out when they next open the app.
   */
  private fun wake(context: Context) {
    if (!LinkPrefs.isEnabled(context)) {
      Trace.detail("wake.skipped", "reason" to "link-disabled")
      return
    }
    try {
      LinkService.start(context)
    } catch (error: Exception) {
      /* Android 12 background-start rules; the outbox is the fallback */
      Trace.warn("wake.refused", "error" to error.javaClass.simpleName)
    }
  }
}
