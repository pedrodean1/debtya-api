# DebtYa — Google Play Internal Testing (checklist)

This document supports **Google Play Console** setup for **Internal testing**. Regenerate the **AAB after each server/UI release** you want reflected in the build (for example after `debtya-2026-05-11-v110-google-play-internal-readiness`).

## AAB output path (local)

After a successful Android release build, the AAB is typically at:

`android/app/build/outputs/bundle/release/app-release.aab`

(Pedro runs `./gradlew bundleRelease` or **Build > Generate Signed Bundle** from Android Studio on a machine with a valid **JAVA_HOME** and signing configured via `android/key.properties`.)

## Build commands (reference)

From repo root (after `npm install` if needed, and `npx cap sync android` when web assets or Capacitor config changed):

```bash
cd android
./gradlew bundleRelease
```

Or use Android Studio: **Build > Generate Signed Bundle / APK > Android App Bundle**.

## versionCode / versionName

Defined in `android/app/build.gradle` (`defaultConfig`):

- **versionName** — user-visible string (e.g. `1.0`).
- **versionCode** — monotonic integer **required by Play** for each new upload.

Rules:

- **First Play upload ever:** `versionCode 1` is OK.
- **If any AAB was already uploaded to Play (any track):** increment `versionCode` (e.g. `2`, `3`, …) before the next upload. Play rejects reuse of the same `versionCode`.

Do **not** bump `versionCode` in the repo automatically unless you are preparing the next store upload; coordinate with what is already on Play.

## Store URLs (production)

| Field | Value |
|--------|--------|
| **Privacy policy** | `https://www.debtya.com/legal.html#privacidad` |
| **Account deletion** | `https://www.debtya.com/legal.html#eliminar-cuenta` |
| **Terms** | `https://www.debtya.com/legal.html#terminos` |

## Support email

`contact@debtya.com`

## Data Safety (Google Play form) — recommended answers

Align declarations with what the app and site actually do. Update if product changes.

| Data type | Collected? | Notes |
|-----------|--------------|--------|
| **Financial info** | Yes | User-entered debt balances, APR, minimum payments, payoff plan inputs. |
| **Personal info / Email** | Yes | Account email, optional phone for SMS reminders if user opts in. |
| **User IDs** | Yes | Application user id (e.g. Supabase auth user id). |
| **App activity** | Yes | Product usage; **Google Analytics (gtag.js)** is enabled on `public/index.html` and `public/legal.html` for aggregated analytics. |
| **Device or other IDs** | Yes (conservative) | GA / browser telemetry may imply device or client identifiers as described in Google’s documentation; declare conservatively unless you complete a narrower GA review. |
| **Approximate location** | Optional / conservative | If you treat IP-based coarse location as possible via analytics or hosting logs, declare **approximate location**; otherwise document your GA IP settings and match the form. |

**Security**

- **Data encrypted in transit:** Yes (HTTPS to API and hosts).

**Data sharing / processors (non-exhaustive)**

- **Supabase** — auth and app database.
- **Render** (or current API host) — API and static hosting.
- **Email:** transactional and reminders (e.g. **Resend** / similar as configured).
- **SMS:** if enabled, provider (e.g. **Twilio**) per env.
- **Google Analytics** — usage analytics on web pages where gtag is loaded.
- **OpenAI** — only if the in-app guide calls the cloud assistant (`OPENAI_API_KEY` configured); otherwise local fallback.

**Account deletion**

- Users request deletion by emailing **contact@debtya.com** from their account email. Policy text: `legal.html#eliminar-cuenta`.

**Sale of data**

- **No sale** of personal data (declare accordingly).

## Legacy integration status endpoints

`GET /method/status` and `GET /spinwheel/status` return **404** `{ "ok": false, "error": "not_found" }` unless `DEBTYA_ALLOW_LEGACY_STATUS_ROUTES=1` is set on the server (internal debugging only). They are **not** part of the public app contract for Play.

## Internal testing checklist

- [ ] `SERVER_VERSION` / UI rev match the release you intend to ship.
- [ ] New **AAB** built **after** the target web/API revision; do not upload an older AAB.
- [ ] `versionCode` incremented if Play already saw a previous code.
- [ ] Privacy policy, terms, and account deletion URLs tested in a browser.
- [ ] Manual-first flows: add debt → plan → dashboard next payment → **I paid it** / confirm manual → history and balance update.
- [ ] Optional: SMS/email reminder opt-in copy and STOP behavior as implemented.
- [ ] Data Safety form in Play Console filled using the table above and adjusted after any change to analytics or processors.
