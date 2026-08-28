package expo.modules.omarchylink

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput

/**
 * What the phone says about a coding agent on the desktop.
 *
 * Two pieces of news, and they are not the same size:
 *
 *   - **It stopped to ask you something.** The one notification in this app
 *     allowed to interrupt. An agent parked on a permission prompt is idle
 *     until a person answers, so the cost of finding out late is however long
 *     the phone stayed in a pocket. It carries a `RemoteInput`, which means
 *     the common answer — "yes", "go ahead", a one-line correction — never
 *     needs the app opened at all, and a tap opens *that* session's chat
 *     rather than whatever screen the app was left on.
 *   - **It finished.** Worth knowing and not worth a sound, so it is a quieter
 *     channel of its own. The JavaScript side is what decides this is news at
 *     all: every turn an agent takes ends idle, and being told about each of
 *     them would be a reason to turn the whole feature off. See
 *     `src/api/alerts.ts`.
 */
object AgentAlerts {
  private const val WAITING_CHANNEL = "omarchy-agent"
  private const val DONE_CHANNEL = "omarchy-agent-done"
  const val REPLY_KEY = "omarchy.reply"

  /**
   * Puts up, or quietly updates, the alert for one blocked session.
   *
   * `alert` is false when the prompt merely changed under an agent that was
   * already waiting: the shade is corrected without buzzing the phone a second
   * time for a question it has already asked about.
   */
  fun waiting(
    context: Context,
    session: String,
    agent: String,
    title: String,
    prompt: String,
    desktop: String?,
    canReply: Boolean,
    alert: Boolean,
  ) {
    val app = context.applicationContext
    Shade.channel(
      app,
      WAITING_CHANNEL,
      "Agent waiting",
      "When a coding agent on your desktop stops to ask you something.",
      NotificationManager.IMPORTANCE_HIGH,
    )

    val body = prompt.ifBlank { "waiting for an answer" }
    val builder = NotificationCompat.Builder(app, WAITING_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_agent_notification)
      .setContentTitle(if (agent.isBlank()) "An agent is waiting" else "$agent is waiting")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSubText(listOfNotNull(title.ifBlank { null }, desktop).firstOrNull())
      .setContentIntent(open(app, Shade.AGENT, session))
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.AGENT, session))
      .setAutoCancel(true)
      .setOnlyAlertOnce(!alert)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)

    // No reply action when the desktop has told us it cannot type into this
    // session — offering a text box that goes nowhere is worse than no box.
    if (canReply) builder.addAction(replyAction(app, session))

    Shade.show(app, Shade.AGENT, session, builder.build())
  }

  /** An agent that was busy for long enough to be worth waiting on is done. */
  fun finished(context: Context, session: String, agent: String, title: String, preview: String, desktop: String?) {
    val app = context.applicationContext
    Shade.channel(
      app,
      DONE_CHANNEL,
      "Agent finished",
      "When a coding agent on your desktop finishes something long.",
      NotificationManager.IMPORTANCE_DEFAULT,
    )

    val body = preview.ifBlank { "done" }
    val builder = NotificationCompat.Builder(app, DONE_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_agent_done)
      .setContentTitle(if (agent.isBlank()) "An agent finished" else "$agent finished")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSubText(listOfNotNull(title.ifBlank { null }, desktop).firstOrNull())
      .setContentIntent(open(app, Shade.DONE, session))
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.DONE, session))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)

    Shade.show(app, Shade.DONE, session, builder.build())
  }

  /** Replaces a waiting alert with a word about the answer given to it. */
  fun note(context: Context, session: String, note: String, desktop: String?) {
    val app = context.applicationContext
    if (!Shade.holds(app, Shade.AGENT, session)) return
    Shade.channel(
      app,
      WAITING_CHANNEL,
      "Agent waiting",
      "When a coding agent on your desktop stops to ask you something.",
      NotificationManager.IMPORTANCE_HIGH,
    )
    val builder = NotificationCompat.Builder(app, WAITING_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_agent_notification)
      .setContentTitle("Agent")
      .setContentText(note)
      .setStyle(NotificationCompat.BigTextStyle().bigText(note))
      .setSubText(desktop)
      .setContentIntent(open(app, Shade.AGENT, session))
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.AGENT, session))
      .setAutoCancel(true)
      // The answer is already given; this is a receipt, not a second question.
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    Shade.show(app, Shade.AGENT, session, builder.build())
  }

  fun cancel(context: Context, kind: String, session: String) = Shade.cancel(context, kind, session)

  /**
   * The deep link the app routes to that session's chat.
   *
   * The nonce is not decoration. React Native delivers a deep link as a value,
   * and a value identical to the last one is not a change — so without it a
   * second question from the same agent would bring the app forward on
   * whatever screen it was left on instead of opening the conversation.
   */
  private fun open(context: Context, kind: String, session: String) =
    Shade.open(
      context,
      kind,
      session,
      "omarchy-connect://agent/${android.net.Uri.encode(session)}?at=${System.currentTimeMillis()}",
    )

  private fun replyAction(context: Context, session: String): NotificationCompat.Action {
    val remote = RemoteInput.Builder(REPLY_KEY).setLabel("Answer the agent").build()
    val pending = Shade.act(context, LinkActionReceiver.ACTION_REPLY, Shade.AGENT, session, mutable = true)
    return NotificationCompat.Action.Builder(R.drawable.omarchy_agent_notification, "Reply", pending)
      .addRemoteInput(remote)
      .setAllowGeneratedReplies(false)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setShowsUserInterface(false)
      .build()
  }
}
