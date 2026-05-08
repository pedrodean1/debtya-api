# Capacitor Asset Sources

This folder is reserved for Capacitor source artwork.

The repo currently has SVG PWA icons in `public/icons/` and a non-square `public/logo.png` (`1024x682`). Android/iOS release artwork still needs reviewed PNG sources, so V92 does not invent final PNG files here.

Expected source files before running `npx capacitor-assets generate`:

- `icon-only.png` at least `1024x1024`
- `icon-foreground.png` at least `1024x1024`
- `icon-background.png` at least `1024x1024`
- `splash.png` at least `2732x2732`
- `splash-dark.png` at least `2732x2732`

What is still missing for release:

- A final square DebtYa app icon PNG, at least `1024x1024`.
- A final splash PNG, at least `2732x2732`.
- A dark splash PNG, at least `2732x2732`, if the launch screen should support a dark variant.
