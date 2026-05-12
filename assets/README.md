# Capacitor asset sources (V111)

DebtYa ships final **square** brand sources here for `@capacitor/assets` and Android/iOS generation.

## Canonical artwork

- **`debtya-official-icon.png`** — fuente maestra oficial del icono DebtYa para Android, PWA, favicon, Apple touch y Google Play.
- **`logo.png`** — derivado 1024×1024 regenerado desde `debtya-official-icon.png` para `@capacitor/assets`.
- **`google-play-icon-512.png`** — derivado 512×512 listo para subir manualmente en Google Play Console.
- **`splash.png`** / **`splash-dark.png`** — 2732×2732, fondo `#0b1220` con el icono oficial centrado (generados por el mismo script).

## Regenerar PNG públicos + `assets/logo.png` + splashes

Tras editar `assets/debtya-official-icon.png`:

```sh
npm run gen:brand
```

Luego regenerar recursos nativos (solo Android en este repo, típico):

```sh
npx @capacitor/assets generate --android --assetPath assets --iconBackgroundColor "#0b1220" --splashBackgroundColor "#0b1220" --splashBackgroundColorDark "#050810"
npx cap sync android
```

## PWA / web

- PNG PWA / favicon / Apple: `public/icons/debtya-192.png`, `debtya-512.png`, `favicon-32.png`, `apple-touch-icon.png`
- Marca en cabecera HTML: `public/logo.png` (1024×1024, cuadrado)
