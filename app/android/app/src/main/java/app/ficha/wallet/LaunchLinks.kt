package app.ficha.wallet

import android.content.Intent

/**
 * A link that opened Ficha (a station's pay link, a receipt) is routed once.
 *
 * Android keeps that link as the activity's intent. When it recreates the
 * activity (the process was killed in the background and the user comes back
 * from the icon or Recents) or relaunches it from Recents, getIntent() is
 * still that first link, and the bridge would route it again: an old Pay form
 * or receipt instead of where the user was. MainActivity starts from a plain
 * launcher intent then. New links still arrive through onNewIntent.
 */
object LaunchLinks {
    /**
     * True when the activity is starting again from a link it already
     * handled: `restored` (there is saved instance state) or launched from
     * Recents, and the intent carries a link.
     */
    @JvmStatic
    fun isReplay(restored: Boolean, flags: Int, hasLink: Boolean): Boolean =
        hasLink && (restored || (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0)
}
