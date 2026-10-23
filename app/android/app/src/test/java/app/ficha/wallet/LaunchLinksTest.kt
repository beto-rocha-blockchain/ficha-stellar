package app.ficha.wallet

import android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY
import android.content.Intent.FLAG_ACTIVITY_NEW_TASK
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Plain JVM test: the Intent flags are compile-time constants. */
class LaunchLinksTest {
    @Test
    fun aFreshLinkIsRouted() {
        // A camera scan or a tapped receipt link: first start of this activity.
        assertFalse(LaunchLinks.isReplay(restored = false, flags = FLAG_ACTIVITY_NEW_TASK, hasLink = true))
    }

    @Test
    fun aLinkIsNotRoutedAgainAfterTheProcessWasKilled() {
        // Back from the icon or Recents: Android recreates the activity with its saved state and its first intent.
        assertTrue(LaunchLinks.isReplay(restored = true, flags = FLAG_ACTIVITY_NEW_TASK, hasLink = true))
    }

    @Test
    fun aLinkIsNotRoutedAgainFromRecents() {
        assertTrue(LaunchLinks.isReplay(restored = false, flags = FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY, hasLink = true))
    }

    @Test
    fun theLauncherIntentIsKept() {
        assertFalse(LaunchLinks.isReplay(restored = true, flags = FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY, hasLink = false))
        assertFalse(LaunchLinks.isReplay(restored = false, flags = 0, hasLink = false))
    }
}
