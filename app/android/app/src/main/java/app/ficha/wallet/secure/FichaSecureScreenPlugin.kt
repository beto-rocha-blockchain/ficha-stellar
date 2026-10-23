package app.ficha.wallet.secure

import android.view.WindowManager
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * FLAG_SECURE on the app window while a screen shows the recovery words or the
 * S... secret: Android then blocks screenshots, screen recording and casting,
 * and shows a blank Recents thumbnail. JS side: src/native/secure-screen.ts,
 * which counts the screens that need it and turns it off after the last one.
 *
 * - setSecure({ secure }): add or clear the flag.
 */
@CapacitorPlugin(name = "FichaSecureScreen")
class FichaSecureScreenPlugin : Plugin() {
    @PluginMethod
    fun setSecure(call: PluginCall) {
        val secure = call.getBoolean("secure") ?: return call.reject("secure is required")
        val act = activity ?: return call.reject("no activity")
        act.runOnUiThread {
            if (secure) {
                act.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                act.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            call.resolve()
        }
    }
}
