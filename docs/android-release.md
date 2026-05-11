# DebtYa Android Release Prep

DebtYa V93 prepares the Android Capacitor shell for signed release builds. It does not publish DebtYa to Google Play.

## Current Android Configuration

- App id / package: `com.debtya.app`
- App name: `DebtYa`
- Capacitor web directory: `public`
- Capacitor remote URL: `https://www.debtya.com`
- Cleartext traffic: disabled in Capacitor and Android manifest.
- Android backup: disabled in the manifest to avoid OS backup of app/WebView data.

## Open Android Studio

From the repo root:

```sh
npm run cap:open:android
```

Equivalent command:

```sh
npx cap open android
```

Android Studio should open the `android/` project. Let Gradle finish syncing before running builds.

## Run An Emulator

In Android Studio:

1. Open Device Manager.
2. Create or select an Android Virtual Device.
3. Start the emulator.
4. Click Run for the `app` configuration.

The app should load `https://www.debtya.com`, not local bundled endpoints.

## Sync Capacitor

After any web, Capacitor, or native config change:

```sh
npx cap sync android
```

## Generate A Debug APK

From the repo root on Windows:

```sh
cd android
gradlew.bat assembleDebug
```

Output path:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Generate A Release AAB

Google Play expects an Android App Bundle for most release flows.

From the repo root on Windows, after release signing is configured:

```sh
cd android
gradlew.bat bundleRelease
```

Output path:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

Do not upload an unsigned or debug artifact to Google Play.

For each **new upload** to Google Play (internal testing or production), increment `versionCode` in `android/app/build.gradle` (and align `versionName` with your release notes). Play Console rejects an AAB whose `versionCode` was already used, even for internal tracks.

## V93 Release Signing

Release signing uses a local file that must not be committed:

```text
android/key.properties
```

Use [android/key.properties.example](../android/key.properties.example) as the template. The expected local values are:

```properties
storeFile=C:\\Users\\Pedro Dean\\Documents\\DebtYa Keys\\debtya-release-key.jks
storePassword=YOUR_PASSWORD_FROM_PASSWORD_MANAGER
keyAlias=debtya
keyPassword=YOUR_PASSWORD_FROM_PASSWORD_MANAGER
```

The Gradle release signing config only activates when `android/key.properties` exists and includes all required values. Debug builds continue to work without this file.

Never commit:

- `.jks` files
- `.keystore` files
- `key.properties`
- passwords or signing secrets

## Create A Keystore

Do not commit keystores, passwords, or signing secrets.

Recommended location outside the repo:

```text
C:\Users\Pedro Dean\Documents\DebtYa Keys\debtya-release-key.jks
```

Recommended alias:

```text
debtya
```

Create the upload keystore with Android Studio or with `keytool`. Store all passwords in a password manager.

Example command:

```sh
keytool -genkeypair -v -keystore "C:\Users\Pedro Dean\Documents\DebtYa Keys\debtya-release-key.jks" -alias debtya -keyalg RSA -keysize 2048 -validity 10000
```

Then create `android/key.properties` locally from the example template and fill it with the real values. Required values:

- Keystore file path
- Key alias
- Keystore password
- Key password

After `android/key.properties` exists locally, generate the release AAB:

```sh
cd android
gradlew.bat bundleRelease
```

The AAB is generated at:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

Upload the AAB in Google Play Console under the chosen testing or production track. Complete the store listing, app access, content rating, data safety, privacy policy, and release notes before rollout.

## Android Assets (V104)

Final square brand sources live under `assets/` and `public/icons/`:

- `assets/logo.png` (1024×1024) — easy mode input for `@capacitor/assets`
- `assets/splash.png` / `assets/splash-dark.png` (2732×2732)
- Vector master: `public/icons/debtya-brand.svg`

Regenerate mipmaps and splashes after changing the SVG:

```sh
npm run gen:brand
npx @capacitor/assets generate --android --assetPath assets --iconBackgroundColor "#0b1220" --splashBackgroundColor "#0b1220" --splashBackgroundColorDark "#050810"
npx cap sync android
```

## Google Play Data Needed

Before publishing, Google Play will require production-ready store and compliance information, including:

- App name, short description, and full description.
- App icon, feature graphic, phone screenshots, and optional tablet screenshots.
- App category and contact email.
- Privacy policy URL.
- Data safety form covering auth, financial/debt data, analytics, diagnostics, and third parties.
- Content rating questionnaire.
- Target audience and ads declaration.
- App access instructions for reviewers, including test credentials if login blocks review.
- Release notes for the first internal/closed test track.

## Pre-Publish Checklist

- Confirm login, signup, password reset, plan rebuild, payment confirmation, AI Coach, and Stripe flows inside the Android WebView.
- Confirm the app always loads `https://www.debtya.com`.
- Confirm no Plaid/Spinwheel/Method, Rules, or Suggested Payments UI is visible.
- Confirm only one next payment is recommended.
- Confirm "Ya lo pague" lowers balance once.
- Confirm launcher and splash match the current DebtYa brand (regenerate with `npm run gen:brand` + `@capacitor/assets` if sources changed).
- Configure release signing with `android/key.properties` and keep signing secrets out of git.
- Build and install a release-signed artifact on a real Android device.
- Generate `android/app/build/outputs/bundle/release/app-release.aab` only after the local keystore is ready.
- Complete Google Play Data Safety and privacy review.
- Run `node --check server.js`, `node --check public/app.js`, `npm test`, `npx cap sync android`, and `gradlew.bat assembleDebug`.

DebtYa is not published to Google Play in V93.
