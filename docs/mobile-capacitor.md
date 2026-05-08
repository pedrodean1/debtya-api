# DebtYa Mobile Capacitor Shell

DebtYa V90 prepares the existing public web app for native mobile shells with Capacitor. This does not publish DebtYa to the App Store or Google Play yet.

## Install dependencies

From the repo root:

```sh
npm install
```

Capacitor packages are included in `package.json`:

- `@capacitor/core`
- `@capacitor/cli`
- `@capacitor/android`
- `@capacitor/ios`
- `@capacitor/assets`

## Sync Capacitor

DebtYa does not use a React/Vite frontend build. Capacitor must point directly to `public/`.

```sh
npm run cap:sync
```

Equivalent command:

```sh
npx cap sync
```

## Open Android Studio

After syncing:

```sh
npm run cap:open:android
```

Equivalent command:

```sh
npx cap open android
```

## Open Xcode

On macOS with Xcode installed:

```sh
npm run cap:open:ios
```

Equivalent command:

```sh
npx cap open ios
```

The iOS project can be kept in the repo, but final iOS validation and archive builds must happen on macOS with Xcode.

## Generate mobile assets

Current PWA icons live in `public/icons/` and are SVG files. Capacitor Assets expects source PNG files for final generation:

- `assets/icon-only.png`
- `assets/icon-foreground.png`
- `assets/icon-background.png`
- `assets/splash.png`
- `assets/splash-dark.png`

Recommended minimums:

- App icons: at least `1024x1024`
- Splash images: at least `2732x2732`

When final PNG artwork is ready, place it in `assets/` and run:

```sh
npx capacitor-assets generate
```

Then run:

```sh
npm run cap:sync
```

## Before publishing

Before submitting to the App Store or Google Play:

- Replace asset placeholders/instructions with final reviewed PNG artwork.
- Confirm production API origin, auth flows, password reset links, Stripe flows, and AI Coach behavior inside native WebView.
- Validate no sensitive debt or auth data is cached beyond the existing web/PWA behavior.
- Configure Android package signing and Play Console listing.
- Configure Apple signing, bundle capabilities, privacy nutrition labels, and App Store Connect listing.
- Run device testing on Android and iOS.

DebtYa is not published to the App Store or Google Play in V90.
