package expo.modules.omarchytelephony

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The promise [Backlog] makes, held to on a real Android framework.
 *
 * `README.md` tells the user that an SMS which arrived at three in the morning
 * with the app closed will be waiting for the desktop. This file is the only
 * thing in the repository that can contradict that. A muddled `remove`, a
 * changed bound, an exception escaping the parse — each of them throws away
 * somebody's private message, and each of them looks like working code.
 *
 * Robolectric because the subject is Android's `SharedPreferences` and
 * Android's `org.json`; in a bare JVM test both are stubs that throw.
 */
/**
 * Android 35 rather than the project's own 36: Robolectric will only bring up
 * a 36 sandbox on Java 21, and CI and this project build on Java 17. Nothing
 * under test here is newer than 35 — it is `SharedPreferences` and
 * `org.json` — so the older framework answers the same questions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BacklogTest {
  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private fun store() =
    context.getSharedPreferences("omarchy-connect.telephony", Context.MODE_PRIVATE)

  private fun sms(from: String, body: String) =
    mapOf<String, Any?>("kind" to "sms", "from" to from, "body" to body)

  @Test
  fun `drain returns what was added, in the order it was added`() {
    Backlog.add(context, sms("+100", "one"))
    Backlog.add(context, sms("+200", "two"))
    Backlog.add(context, sms("+300", "three"))

    val held = Backlog.drain(context)

    assertEquals(3, held.size)
    assertEquals(listOf("+100", "+200", "+300"), held.map { it["from"] })
    assertEquals(listOf("one", "two", "three"), held.map { it["body"] })
    assertTrue(held.all { it["kind"] == "sms" })
  }

  @Test
  fun `a second drain comes back empty`() {
    Backlog.add(context, sms("+100", "one"))

    assertEquals(1, Backlog.drain(context).size)
    assertEquals(emptyList<Map<String, Any?>>(), Backlog.drain(context))
  }

  @Test
  fun `an empty backlog drains to nothing`() {
    assertEquals(emptyList<Map<String, Any?>>(), Backlog.drain(context))
    assertEquals(0, Backlog.size(context))
  }

  /**
   * The bound is 200, and the entry dropped on reaching it is the oldest.
   * Dropping the newest instead would mean a phone that has been out of touch
   * for a long time keeps a stale morning and loses everything since.
   */
  @Test
  fun `the two-hundred-and-first entry pushes out the oldest, not the newest`() {
    for (index in 1..201) Backlog.add(context, sms("+$index", "body-$index"))

    val held = Backlog.drain(context)

    assertEquals(200, held.size)
    assertEquals("+2", held.first()["from"])
    assertEquals("+201", held.last()["from"])
    assertEquals((2..201).map { "+$it" }, held.map { it["from"] })
  }

  /**
   * A missed call has no body and an unknown caller has no contact name. Both
   * are written as an explicit `null`, and both have to come back out as one —
   * a `null` turned into the string "null" on the way through would be
   * rendered on the desktop as a message from a person called null.
   */
  @Test
  fun `a null field survives add and drain as a null`() {
    Backlog.add(
      context,
      mapOf("kind" to "call", "from" to "+100", "contact" to null, "body" to null),
    )

    val entry = Backlog.drain(context).single()

    assertEquals("call", entry["kind"])
    assertEquals("+100", entry["from"])
    assertTrue(entry.containsKey("contact"))
    assertNull(entry["contact"])
    assertTrue(entry.containsKey("body"))
    assertNull(entry["body"])
  }

  @Test
  fun `size agrees with how much a drain will hand over`() {
    assertEquals(0, Backlog.size(context))
    for (index in 1..7) Backlog.add(context, sms("+$index", "body-$index"))
    assertEquals(7, Backlog.size(context))

    // And asking is not taking: the count survives being read.
    assertEquals(7, Backlog.size(context))
    assertEquals(Backlog.size(context), Backlog.drain(context).size)
    assertEquals(0, Backlog.size(context))
  }

  @Test
  fun `size stays inside the bound once the bound is reached`() {
    for (index in 1..250) Backlog.add(context, sms("+$index", "body-$index"))

    assertEquals(200, Backlog.size(context))
    assertEquals(200, Backlog.drain(context).size)
  }

  /**
   * Unreadable storage has already lost everything held; an exception on top
   * of that would take down the drain that runs the moment the app connects,
   * and with it every later message too.
   */
  @Test
  fun `garbage in storage drains to nothing instead of throwing`() {
    store().edit().putString("backlog", "{not json at all").commit()

    assertEquals(0, Backlog.size(context))
    assertEquals(emptyList<Map<String, Any?>>(), Backlog.drain(context))

    Backlog.add(context, sms("+100", "after"))
    assertEquals("+100", Backlog.drain(context).single()["from"])
  }

  @Test
  fun `a drained backlog leaves nothing behind in storage`() {
    Backlog.add(context, sms("+100", "one"))
    Backlog.drain(context)

    assertTrue(store().getString("backlog", null) == null)
  }
}
