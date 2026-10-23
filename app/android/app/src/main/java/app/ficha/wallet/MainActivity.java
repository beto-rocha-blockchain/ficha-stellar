package app.ficha.wallet;

import android.content.Intent;
import android.os.Bundle;
import app.ficha.wallet.battery.FichaBatteryPlugin;
import app.ficha.wallet.biometric.FichaBiometricPlugin;
import app.ficha.wallet.secure.FichaSecureScreenPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(FichaBatteryPlugin.class);
        registerPlugin(FichaSecureScreenPlugin.class);
        registerPlugin(FichaBiometricPlugin.class);
        // The bridge routes getIntent()'s link (appUrlOpen and getLaunchUrl).
        // Do not route again a link that was already handled (LaunchLinks).
        Intent intent = getIntent();
        if (intent != null && LaunchLinks.isReplay(savedInstanceState != null, intent.getFlags(), intent.getData() != null)) {
            setIntent(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setClass(this, MainActivity.class));
        }
        super.onCreate(savedInstanceState);
    }
}
