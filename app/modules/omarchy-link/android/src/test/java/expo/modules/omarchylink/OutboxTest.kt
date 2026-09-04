package expo.modules.omarchylink

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The promise [Outbox] makes, held to on a real Android framework.
 *
 * Nothing here is about the shade, the service or the socket. What is being
 * pinned down is the small amount of bookkeeping between a person tapping
 * `reply` on a notification and the link having a connection to send it on —
 * because that bookkeeping is a hand-rolled `JSONArray` in
 * `SharedPreferences`, and a regression in it loses the answer somebody typed
 * without saying anything to anybody.
 *
 * Robolectric rather than a plain JVM test on purpose: this file's subject is
 * Android's `SharedPreferences` and Android's `org.json`, both of which are
 * empty stubs that throw in a bare unit test. Running the real ones is the
 * whole point.
 */
/**
 * Android 35 rather than the project's own 36: Robolectric will only bring up
 * a 36 sandbox on Java 21, and CI and this project build on Java 17. Nothing
 * under test here is newer than 35 — it is `SharedPreferences` and
 * `org.json` — so the older framework answers the same questions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OutboxTest {
  private val context: Context get() = ApplicationProvider.getApplicationContext()

  /** What the object writes into, reached the way a corrupting bug would. */
  private fun store() =
    context.getSharedPreferences("omarchy-connect.link", Context.MODE_PRIVATE)

  @Test
  fun `drain returns what was added, in the order it was added`() {
    Outbox.add(context, "reply", "session-1", "first")
    Outbox.add(context, "save", "offer-2", "photo.png")
    Outbox.add(context, "reply", "session-3", "third")

    val work = Outbox.drain(context)

    assertEquals(3, work.size)
    assertEquals(listOf("reply", "save", "reply"), work.map { it["kind"] })
    assertEquals(listOf("session-1", "offer-2", "session-3"), work.map { it["id"] })
    assertEquals(listOf("first", "photo.png", "third"), work.map { it["text"] })
  }

  @Test
  fun `a second drain comes back empty`() {
    Outbox.add(context, "reply", "session-1", "first")

    assertEquals(1, Outbox.drain(context).size)
    assertEquals(emptyList<Map<String, Any?>>(), Outbox.drain(context))
  }

  @Test
  fun `an empty outbox drains to nothing`() {
    assertEquals(emptyList<Map<String, Any?>>(), Outbox.drain(context))
  }

  /**
   * The bound is 30, and the thing dropped when it is reached is the *oldest*.
   * Dropping the newest instead would be a one-character change that no
   * compiler and no other test would notice, and it would silently throw away
   * the reply somebody had just that second typed.
   */
  @Test
  fun `the thirty-first item pushes out the oldest, not the newest`() {
    for (index in 1..31) Outbox.add(context, "reply", "session-$index", "text-$index")

    val work = Outbox.drain(context)

    assertEquals(30, work.size)
    assertEquals("session-2", work.first()["id"])
    assertEquals("session-31", work.last()["id"])
    assertEquals((2..31).map { "session-$it" }, work.map { it["id"] })
  }

  /**
   * Unreadable storage is a loss either way; what must not happen is the
   * exception, because `drain` runs on the link's own path and a throw there
   * takes the connection down instead of one queued item.
   */
  @Test
  fun `garbage in storage drains to nothing instead of throwing`() {
    store().edit().putString("outbox", "{not json at all").commit()

    assertEquals(emptyList<Map<String, Any?>>(), Outbox.drain(context))

    // And the object is usable again afterwards.
    Outbox.add(context, "reply", "session-after", "still here")
    assertEquals("session-after", Outbox.drain(context).single()["id"])
  }

  /** An entry with no `kind` or no `id` is not work anybody can do. */
  @Test
  fun `an entry missing its kind or id is dropped rather than handed on`() {
    store().edit().putString(
      "outbox",
      """[{"id":"a","text":"no kind"},{"kind":"reply","text":"no id"},{"kind":"reply","id":"c","text":"whole"}]""",
    ).commit()

    val work = Outbox.drain(context)

    assertEquals(1, work.size)
    assertEquals("c", work.single()["id"])
  }

  @Test
  fun `a drained outbox leaves nothing behind in storage`() {
    Outbox.add(context, "reply", "session-1", "first")
    Outbox.drain(context)

    assertTrue(store().getString("outbox", null) == null)
  }
}
