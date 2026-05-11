# Capacitor asset sources (V104)

DebtYa ships final **square** brand sources here for `@capacitor/assets` and Android/iOS generation.

## Canonical artwork

- **`logo.png`** — 1024×1024, monograma **dy**, degradado azul sobre fondo oscuro redondeado (misma pieza que `public/icons/debtya-brand.svg` rasterizada con `npm run gen:brand`).
- **`splash.png`** / **`splash-dark.png`** — 2732×2732, fondo `#0b1220` con el logo centrado (generados por el mismo script).

## Regenerar PNG públicos + `assets/logo.png` + splashes

Tras editar `public/icons/debtya-brand.svg`:

```sh
npm run gen:brand
```

Luego regenerar recursos nativos (solo Android en este repo, típico):

```sh
npx @capacitor/assets generate --android --assetPath assets --iconBackgroundColor "#0b1220" --splashBackgroundColor "#0b1220" --splashBackgroundColorDark "#050810"
npx cap sync android
```

## PWA / web

- Vectores: `public/icons/debtya-192.svg`, `public/icons/debtya-512.svg`, `public/icons/debtya-brand.svg`
- PNG PWA / favicon / Apple: `public/icons/debtya-192.png`, `debtya-512.png`, `favicon-32.png`, `apple-touch-icon.png`
- Marca en cabecera HTML: `public/logo.png` (1024×1024, cuadrado)
