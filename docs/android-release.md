# DebtYa Android Release Prep

DebtYa V92 prepares the Android Capacitor shell for publication work. It does not publish DebtYa to Google Play.

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

## Create A Keystore

Do not commit keystores, passwords, or signing secrets.

Create a real upload keystore with owner-approved values:

```sh
keytool -genkeypair -v -keystore debtya-upload-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias debtya-upload
```

Store the keystore outside the repo or in a secure secret store. Configure Gradle signing with environment variables or a local, ignored properties file. Required values usually include:

- Keystore file path
- Key alias
- Keystore password
- Key password

## Android Assets

Current source assets are not final release assets:

- `public/icons/debtya-192.svg`
- `public/icons/debtya-512.svg`
- `public/logo.png` is `1024x682`, not square.

Before generating final assets, add reviewed PNG artwork:

- `assets/icon-only.png` at least `1024x1024`
- `assets/icon-foreground.png` at least `1024x1024`
- `assets/icon-background.png` at least `1024x1024`
- `assets/splash.png` at least `2732x2732`
- `assets/splash-dark.png` at least `2732x2732`, if needed

Then run:

```sh
npx capacitor-assets generate --android
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
- Replace placeholder/default Android icons and splash with final reviewed DebtYa artwork.
- Configure release signing and keep signing secrets out of git.
- Build and install a release-signed artifact on a real Android device.
- Complete Google Play Data Safety and privacy review.
- Run `node --check server.js`, `node --check public/app.js`, `npm test`, `npx cap sync android`, and `gradlew.bat assembleDebug`.

DebtYa is not published to Google Play in V92.
