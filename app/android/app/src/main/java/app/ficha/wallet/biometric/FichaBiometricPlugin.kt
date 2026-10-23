package app.ficha.wallet.biometric

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Unlock with the phone's biometrics. JS side: src/native/biometric.ts, policy
 * in src/wallet/biometric.ts.
 *
 * enable() makes a random 32-byte unlock key here and returns it once,
 * together with that key encrypted by an AES-256-GCM key that lives in the
 * Android Keystore (StrongBox when the phone has one), never leaves it, and
 * works only for one operation right after a strong (class 3) biometric
 * check. JS seals the PIN with the unlock key and keeps only ciphertexts;
 * unlock() gives the unlock key back after the owner's finger or face.
 *
 * Why not hand the PIN itself to native: Capacitor logs the arguments of
 * every call from JS (verbose, debug builds), never the results. So secrets
 * only ever travel native -> JS here.
 *
 * - isAvailable() -> { available, strong, reason }
 * - enable({ title, subtitle?, cancel }) -> { key, ciphertext, iv } (base64)
 * - unlock({ ciphertext, iv, title, subtitle?, cancel }) -> { key }
 * - disable(): delete the Keystore key (the ciphertexts become useless).
 *
 * Errors reject with a code: cancelled (the user closed the prompt or tapped
 * its button), interrupted (the system closed it: the app went to the
 * background, or nobody answered before it timed out; or it could not open
 * because the app was no longer in the foreground), lockout (too many
 * wrong fingers), invalidated (a fingerprint or face was added, or all were
 * removed: the key is gone for good), unavailable (no hardware or nothing
 * enrolled), busy, failed. Nothing here logs a key or a ciphertext.
 */
@CapacitorPlugin(name = "FichaBiometric")
class FichaBiometricPlugin : Plugin() {
    /** The prompt on screen, if any: one at a time. */
    private var active: BiometricPrompt? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val bm = BiometricManager.from(context)
        val strong = bm.canAuthenticate(BIOMETRIC_STRONG)
        val any = strong == BiometricManager.BIOMETRIC_SUCCESS || bm.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS
        val reason = reasonName(strong)
        // Availability only: never the secret.
        Log.i(TAG, "isAvailable: available=$any strong=${strong == BiometricManager.BIOMETRIC_SUCCESS} reason=$reason sdk=${Build.VERSION.SDK_INT}")
        call.resolve(JSObject().apply {
            put("available", any)
            put("strong", strong == BiometricManager.BIOMETRIC_SUCCESS)
            put("reason", reason)
        })
    }

    @PluginMethod
    fun enable(call: PluginCall) {
        val texts = texts(call) ?: return
        if (!strongReady(call)) return
        val cipher = try {
            deleteKey()
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, createKey()) }
        } catch (e: Exception) {
            Log.w(TAG, "enable: key setup failed: ${e.javaClass.simpleName}")
            deleteKey()
            return call.reject("key setup failed", "failed")
        }
        prompt(call, cipher, texts) { c ->
            val unlockKey = ByteArray(UNLOCK_KEY_BYTES).also { SecureRandom().nextBytes(it) }
            try {
                val data = c.doFinal(unlockKey)
                JSObject().apply {
                    put("key", Base64.encodeToString(unlockKey, Base64.NO_WRAP))
                    put("ciphertext", Base64.encodeToString(data, Base64.NO_WRAP))
                    put("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
                }
            } finally {
                Arrays.fill(unlockKey, 0)
            }
        }
    }

    @PluginMethod
    fun unlock(call: PluginCall) {
        val data = decode(call.getString("ciphertext"))
        val iv = decode(call.getString("iv"))
        if (data == null || iv == null) return call.reject("ciphertext and iv are required", "failed")
        val texts = texts(call) ?: return
        // Open the cipher first: a key invalidated by a new enrollment (or by
        // removing every fingerprint) must say so, not "unavailable".
        val cipher = try {
            val key = loadKey() ?: return call.reject("key missing", "invalidated")
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            deleteKey()
            return call.reject("key invalidated", "invalidated")
        } catch (e: Exception) {
            Log.w(TAG, "unlock: key setup failed: ${e.javaClass.simpleName}")
            return call.reject("key setup failed", "failed")
        }
        if (!strongReady(call)) return
        prompt(call, cipher, texts) { c ->
            val unlockKey = c.doFinal(data)
            try {
                JSObject().apply { put("key", Base64.encodeToString(unlockKey, Base64.NO_WRAP)) }
            } finally {
                Arrays.fill(unlockKey, 0)
            }
        }
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        deleteKey()
        call.resolve()
    }

    private class Texts(val title: String, val subtitle: String?, val cancel: String)

    private fun texts(call: PluginCall): Texts? {
        val title = call.getString("title")
        val cancel = call.getString("cancel")
        if (title.isNullOrBlank() || cancel.isNullOrBlank()) {
            call.reject("title and cancel are required", "failed")
            return null
        }
        return Texts(title, call.getString("subtitle")?.takeIf { it.isNotBlank() }, cancel)
    }

    /** Strong biometrics enrolled and usable right now; rejects the call otherwise. */
    private fun strongReady(call: PluginCall): Boolean {
        val r = BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)
        if (r == BiometricManager.BIOMETRIC_SUCCESS) return true
        call.reject("biometrics unavailable: ${reasonName(r)}", "unavailable")
        return false
    }

    /**
     * Show the system prompt bound to `cipher` and, once the owner passes it,
     * run `finish` with the unlocked cipher and resolve with its result.
     */
    private fun prompt(call: PluginCall, cipher: Cipher, texts: Texts, finish: (Cipher) -> JSObject) {
        val act = activity as? FragmentActivity ?: return call.reject("no activity", "unavailable")
        act.runOnUiThread {
            if (active != null) return@runOnUiThread call.reject("a prompt is already open", "busy")
            // Once the activity has saved its state (the app went to the background or
            // the screen turned off after JS asked), BiometricPrompt refuses to start
            // without a callback or an exception: the call would never settle and every
            // later one would be "busy". JS asks again when the app is visible.
            if (!canShowPrompt(act)) return@runOnUiThread call.reject("the app is not in the foreground", "interrupted")
            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    active = null
                    val c = result.cryptoObject?.cipher ?: return call.reject("no cipher", "failed")
                    try {
                        call.resolve(finish(c))
                    } catch (e: Exception) {
                        // AEADBadTagException and friends: wrong or damaged ciphertext.
                        Log.w(TAG, "crypto failed after auth: ${e.javaClass.simpleName}")
                        call.reject("crypto failed", "failed")
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    active = null
                    call.reject(errString.toString(), errorName(errorCode))
                }

                // onAuthenticationFailed (a finger that does not match) keeps the
                // prompt open; the system counts those and ends in a lockout error.
            }
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(texts.title)
                .apply { texts.subtitle?.let(::setSubtitle) }
                .setNegativeButtonText(texts.cancel)
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build()
            try {
                val p = BiometricPrompt(act, ContextCompat.getMainExecutor(act), callback)
                active = p
                p.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            } catch (e: Exception) {
                active = null
                Log.w(TAG, "prompt failed: ${e.javaClass.simpleName}")
                call.reject("prompt failed", "failed")
            }
        }
    }

    private fun canShowPrompt(act: FragmentActivity): Boolean =
        !act.isFinishing && !act.isDestroyed && !act.supportFragmentManager.isStateSaved &&
            act.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun loadKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun deleteKey() {
        try {
            keyStore().deleteEntry(KEY_ALIAS)
        } catch (e: Exception) {
            Log.w(TAG, "deleteKey: ${e.javaClass.simpleName}")
        }
    }

    /** A new AES-256 key usable only right after a strong biometric check, one operation per check. */
    private fun createKey(): SecretKey {
        val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        if (strongBox) {
            try {
                return generate(strongBox = true)
            } catch (e: Exception) {
                // StrongBoxUnavailableException (API 28+) or a chip that refuses this key.
                Log.i(TAG, "StrongBox refused the key (${e.javaClass.simpleName}), using the TEE keystore")
            }
        }
        return generate(strongBox = false)
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Timeout 0 = every use needs its own check; strong biometrics only, no device PIN.
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                }
                // Below API 30 the default (no validity duration) already means one
                // check per use, and only a fingerprint can authorize such a key.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) setInvalidatedByBiometricEnrollment(true)
                if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(spec)
            generateKey()
        }
    }

    private fun decode(s: String?): ByteArray? =
        if (s.isNullOrEmpty()) null else try { Base64.decode(s, Base64.NO_WRAP) } catch (e: IllegalArgumentException) { null }

    companion object {
        private const val TAG = "FichaBiometric"
        private const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "ficha_biometric_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val UNLOCK_KEY_BYTES = 32

        fun reasonName(r: Int): String = when (r) {
            BiometricManager.BIOMETRIC_SUCCESS -> "ok"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "none_enrolled"
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no_hardware"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw_unavailable"
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "security_update_required"
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> "unsupported"
            else -> "unknown"
        }

        fun errorName(code: Int): String = when (code) {
            BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_USER_CANCELED -> "cancelled"
            BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT -> "interrupted"
            BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
            BiometricPrompt.ERROR_NO_BIOMETRICS, BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE,
            BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL, BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> "unavailable"
            else -> "failed"
        }
    }
}
