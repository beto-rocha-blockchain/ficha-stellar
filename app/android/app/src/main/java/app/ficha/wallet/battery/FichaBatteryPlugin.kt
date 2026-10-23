package app.ficha.wallet.battery

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.math.abs
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * The phone's own battery, read with BatteryManager: current, voltage, level,
 * charge status and what it is plugged into. JS side: src/native/battery.ts.
 *
 * - getStatus(): one reading.
 * - "battery" event: one reading per second while the app is visible (started)
 *   and at least one JS listener is attached; it stops on its own otherwise.
 *
 * Current is normalised the same way as meter.py on the station: the unit
 * (uA vs mA) is decided by magnitude and sticks, and the sign is learned from
 * the charge status so that positive always means current flowing INTO the
 * battery. Integer.MIN_VALUE from CURRENT_NOW means the phone does not report it.
 */
@CapacitorPlugin(name = "FichaBattery")
class FichaBatteryPlugin : Plugin() {
    private val handler = Handler(Looper.getMainLooper())
    private val current = CurrentNormalizer()
    private var visible = false
    private var ticking = false

    private val tick = object : Runnable {
        override fun run() {
            if (!visible || !hasListeners(EVENT)) {
                ticking = false
                return
            }
            notifyListeners(EVENT, read())
            handler.postDelayed(this, PERIOD_MS)
        }
    }

    override fun load() {
        visible = activity?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) == true
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(read())
    }

    // Re-declared (annotations are not inherited) so a new listener starts the ticker.
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    override fun addListener(call: PluginCall) {
        super.addListener(call)
        startTicking()
    }

    override fun handleOnStart() {
        visible = true
        startTicking()
    }

    override fun handleOnStop() {
        visible = false
        handler.removeCallbacks(tick)
        ticking = false
    }

    override fun handleOnDestroy() {
        handler.removeCallbacks(tick)
        ticking = false
    }

    private fun startTicking() {
        handler.post {
            if (!ticking && visible && hasListeners(EVENT)) {
                ticking = true
                tick.run()
            }
        }
    }

    private fun read(): JSObject {
        val ctx = context
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager?
        // Sticky system broadcast: a null receiver just returns the last value.
        val sticky: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        val rawCurrent = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: Int.MIN_VALUE
        val currentMa = current.toMilliamps(rawCurrent, status)
        val voltageMv = sticky?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0)?.takeIf { it > 0 }?.let(::normalizeMv)

        var level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: Int.MIN_VALUE
        if (level !in 0..100) {
            val l = sticky?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val s = sticky?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            level = if (l >= 0 && s > 0) (l * 100f / s).roundToInt() else Int.MIN_VALUE
        }
        val tenthsC = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE

        return JSObject().apply {
            put("currentSupported", currentMa != null)
            putOrNull("currentMa", currentMa?.roundToInt())
            put("currentUnit", current.unitName())
            put("signKnown", current.signKnown())
            putOrNull("voltageMv", voltageMv)
            putOrNull("powerMw", if (currentMa != null && voltageMv != null) (currentMa * voltageMv / 1000.0).roundToInt() else null)
            putOrNull("levelPct", level.takeIf { it in 0..100 })
            put("status", statusName(status))
            put("plugged", pluggedName(plugged))
            putOrNull("temperatureC", tenthsC.takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 })
            put("rawCurrent", if (rawCurrent == Int.MIN_VALUE) JSONObject.NULL else rawCurrent)
            put("at", System.currentTimeMillis())
        }
    }

    private fun JSObject.putOrNull(key: String, value: Any?) {
        put(key, value ?: JSONObject.NULL)
    }

    companion object {
        const val EVENT = "battery"
        const val PERIOD_MS = 1000L

        fun statusName(s: Int): String = when (s) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
            else -> "unknown"
        }

        fun pluggedName(p: Int): String = when {
            p < 0 -> "unknown"
            p == 0 -> "none"
            p and BatteryManager.BATTERY_PLUGGED_AC != 0 -> "ac"
            p and BatteryManager.BATTERY_PLUGGED_USB != 0 -> "usb"
            p and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0 -> "wireless"
            p and 8 != 0 -> "dock" // BATTERY_PLUGGED_DOCK, API 33
            else -> "unknown"
        }

        /** Battery voltage to millivolts, whatever unit the driver used (as meter.normalize_mv). */
        fun normalizeMv(raw: Int): Int {
            val v = abs(raw)
            return when {
                v >= 100_000 -> (raw / 1000.0).roundToInt() // microvolts
                v >= 1000 -> raw // millivolts (the documented unit)
                else -> raw * 1000 // volts, seen on a few odd drivers
            }
        }
    }
}

/**
 * CURRENT_NOW to signed milliamps, positive = charging (mirrors meter.py).
 *
 * Unit: documented as microamps, but some drivers report mA. A phone never
 * draws 10 A, so a |value| >= 10 000 means uA, and that decision sticks.
 * Sign: documented as positive = into the battery, but some drivers invert it.
 * Only "discharging" is trusted outright (a "charging" phone can be net
 * negative under load), so it votes 3 and a strong charging current votes 1.
 */
class CurrentNormalizer {
    private var unitUa = false
    private var unitDecided = false
    private var signVotes = 0

    fun toMilliamps(raw: Int, status: Int): Double? {
        if (raw == Int.MIN_VALUE) return null
        if (abs(raw) >= UA_THRESHOLD) {
            unitUa = true
            unitDecided = true
        }
        val ma = if (unitUa) raw / 1000.0 else raw.toDouble()
        learnSign(ma, status)
        return ma * sign()
    }

    fun unitName(): String = if (unitDecided) "uA" else "unknown"

    fun signKnown(): Boolean = abs(signVotes) >= 6

    private fun sign(): Int = if (signVotes < 0) -1 else 1

    private fun learnSign(ma: Double, status: Int) {
        val vote = when {
            status == BatteryManager.BATTERY_STATUS_DISCHARGING && abs(ma) >= 20 -> if (ma < 0) 3 else -3
            status == BatteryManager.BATTERY_STATUS_CHARGING && abs(ma) >= 300 -> if (ma > 0) 1 else -1
            else -> return
        }
        signVotes = (signVotes + vote).coerceIn(-30, 30)
    }

    companion object {
        const val UA_THRESHOLD = 10_000
    }
}
