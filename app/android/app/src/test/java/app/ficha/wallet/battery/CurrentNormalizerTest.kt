package app.ficha.wallet.battery

import android.os.BatteryManager.BATTERY_STATUS_CHARGING
import android.os.BatteryManager.BATTERY_STATUS_DISCHARGING
import android.os.BatteryManager.BATTERY_STATUS_FULL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CurrentNormalizer and normalizeMv must behave like meter.py on the station
 * (AdbMeter._raw_ma, _learn_sign, sign_known and normalize_mv). Plain JVM test:
 * the BatteryManager status values are compile-time constants.
 */
class CurrentNormalizerTest {
    private val delta = 1e-9

    @Test
    fun notReported() {
        val n = CurrentNormalizer()
        assertNull(n.toMilliamps(Int.MIN_VALUE, BATTERY_STATUS_DISCHARGING))
        assertEquals("unknown", n.unitName())
        assertFalse(n.signKnown())
    }

    @Test
    fun smallValuesAreMilliampsUntilAMicroampValueIsSeen() {
        val n = CurrentNormalizer()
        assertEquals(500.0, n.toMilliamps(500, BATTERY_STATUS_FULL)!!, delta)
        assertEquals("unknown", n.unitName())
        // A phone never draws 10 A: 10 000 and above is uA.
        assertEquals(-1500.0, n.toMilliamps(-1_500_000, BATTERY_STATUS_DISCHARGING)!!, delta)
        assertEquals("uA", n.unitName())
        // The unit sticks: a later small value is uA too.
        assertEquals(0.8, n.toMilliamps(800, BATTERY_STATUS_FULL)!!, delta)
        assertEquals("uA", n.unitName())
    }

    @Test
    fun unitThresholdIsTenThousand() {
        val below = CurrentNormalizer()
        assertEquals(9999.0, below.toMilliamps(9999, BATTERY_STATUS_FULL)!!, delta)
        assertEquals("unknown", below.unitName())
        val at = CurrentNormalizer()
        assertEquals(10.0, at.toMilliamps(10_000, BATTERY_STATUS_FULL)!!, delta)
        assertEquals("uA", at.unitName())
    }

    @Test
    fun invertedDriverIsFlippedByDischargingVotes() {
        val n = CurrentNormalizer()
        // Discharging but reported positive: the driver's sign is inverted (vote -3).
        assertEquals(-1200.0, n.toMilliamps(1_200_000, BATTERY_STATUS_DISCHARGING)!!, delta)
        assertFalse(n.signKnown())
        assertEquals(-1100.0, n.toMilliamps(1_100_000, BATTERY_STATUS_DISCHARGING)!!, delta)
        assertTrue(n.signKnown()) // |votes| >= 6
        // Charging now reads positive after the flip.
        assertEquals(900.0, n.toMilliamps(-900_000, BATTERY_STATUS_CHARGING)!!, delta)
    }

    @Test
    fun dischargingBelowTwentyMilliampsDoesNotVote() {
        val n = CurrentNormalizer()
        repeat(5) { n.toMilliamps(19_000, BATTERY_STATUS_DISCHARGING) }
        assertFalse(n.signKnown())
        assertEquals(19.0, n.toMilliamps(19_000, BATTERY_STATUS_DISCHARGING)!!, delta)
    }

    @Test
    fun chargingOnlyVotesOneAndOnlyFromThreeHundredMilliamps() {
        val n = CurrentNormalizer()
        repeat(10) { n.toMilliamps(299_000, BATTERY_STATUS_CHARGING) }
        assertFalse(n.signKnown())
        repeat(5) { n.toMilliamps(300_000, BATTERY_STATUS_CHARGING) }
        assertFalse(n.signKnown()) // 5 votes of 1
        n.toMilliamps(300_000, BATTERY_STATUS_CHARGING)
        assertTrue(n.signKnown())
    }

    @Test
    fun chargingUnderLoadDoesNotOverturnDischargingEvidence() {
        val n = CurrentNormalizer()
        n.toMilliamps(-800_000, BATTERY_STATUS_DISCHARGING) // +3
        n.toMilliamps(-800_000, BATTERY_STATUS_DISCHARGING) // +6
        // "Charging" yet net negative under load (-1 each): 6 -> 1, still normal.
        repeat(5) { n.toMilliamps(-400_000, BATTERY_STATUS_CHARGING) }
        assertEquals(-400.0, n.toMilliamps(-400_000, BATTERY_STATUS_FULL)!!, delta)
    }

    @Test
    fun votesAreClampedAtThirty() {
        val n = CurrentNormalizer()
        repeat(50) { n.toMilliamps(-800_000, BATTERY_STATUS_DISCHARGING) } // would be +150
        // From +30, ten inverted votes (-3) reach 0 (normal); one more flips it.
        repeat(10) { n.toMilliamps(800_000, BATTERY_STATUS_DISCHARGING) }
        assertEquals(800.0, n.toMilliamps(800_000, BATTERY_STATUS_FULL)!!, delta)
        n.toMilliamps(800_000, BATTERY_STATUS_DISCHARGING)
        assertEquals(-800.0, n.toMilliamps(800_000, BATTERY_STATUS_FULL)!!, delta)
    }

    @Test
    fun voltageToMillivolts() {
        assertEquals(4200, FichaBatteryPlugin.normalizeMv(4_200_000)) // uV
        assertEquals(3871, FichaBatteryPlugin.normalizeMv(3_871_000))
        assertEquals(100, FichaBatteryPlugin.normalizeMv(100_000)) // uV threshold
        assertEquals(4200, FichaBatteryPlugin.normalizeMv(4200)) // mV, the documented unit
        assertEquals(1000, FichaBatteryPlugin.normalizeMv(1000))
        assertEquals(4000, FichaBatteryPlugin.normalizeMv(4)) // V, a few odd drivers
    }

    @Test
    fun statusAndPlugNames() {
        assertEquals("charging", FichaBatteryPlugin.statusName(BATTERY_STATUS_CHARGING))
        assertEquals("discharging", FichaBatteryPlugin.statusName(BATTERY_STATUS_DISCHARGING))
        assertEquals("full", FichaBatteryPlugin.statusName(BATTERY_STATUS_FULL))
        assertEquals("unknown", FichaBatteryPlugin.statusName(-1))
        assertEquals("none", FichaBatteryPlugin.pluggedName(0))
        assertEquals("unknown", FichaBatteryPlugin.pluggedName(-1))
        assertEquals("usb", FichaBatteryPlugin.pluggedName(2))
        assertEquals("dock", FichaBatteryPlugin.pluggedName(8))
    }
}
