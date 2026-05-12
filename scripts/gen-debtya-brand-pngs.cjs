/**
 * Rasteriza PNGs oficiales de DebtYa desde assets/debtya-official-icon.png
 * (PWA, favicon, apple-touch, logo cuadrado y Google Play icon).
 * Requiere: npm install (sharp en devDependencies).
 * Uso: node scripts/gen-debtya-brand-pngs.cjs
 */
"use strict";

const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("Missing sharp. Run: npm install");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const assetsDir = path.join(root, "assets");
const iconsDir = path.join(root, "public", "icons");
const publicDir = path.join(root, "public");
const preferredSource = path.join(assetsDir, "debtya-official-icon.png");
const fallbackSource = path.join(assetsDir, "assetsdebtya-official-icon.png");

async function resolveSourcePath() {
  try {
    await fs.promises.access(preferredSource, fs.constants.F_OK);
    return preferredSource;
  } catch {}

  try {
    await fs.promises.access(fallbackSource, fs.constants.F_OK);
    await fs.promises.copyFile(fallbackSource, preferredSource);
    return preferredSource;
  } catch {}

  throw new Error(
    "Missing official icon. Expected assets/debtya-official-icon.png (fallback: assets/assetsdebtya-official-icon.png)."
  );
}

async function main() {
  const sourcePath = await resolveSourcePath();
  const official = fs.readFileSync(sourcePath);

  await sharp(official).resize(192, 192).png().toFile(path.join(iconsDir, "debtya-192.png"));
  await sharp(official).resize(512, 512).png().toFile(path.join(iconsDir, "debtya-512.png"));
  await sharp(official).resize(180, 180).png().toFile(path.join(iconsDir, "apple-touch-icon.png"));
  await sharp(official).resize(32, 32).png().toFile(path.join(iconsDir, "favicon-32.png"));
  await sharp(official).resize(1024, 1024).png().toFile(path.join(publicDir, "logo.png"));
  await sharp(official).resize(1024, 1024).png().toFile(path.join(assetsDir, "logo.png"));
  await sharp(official).resize(512, 512).png().toFile(path.join(assetsDir, "google-play-icon-512.png"));

  const logoSplash = await sharp(official).resize(820, 820).png().toBuffer();
  await sharp({
    create: {
      width: 2732,
      height: 2732,
      channels: 4,
      background: { r: 11, g: 18, b: 32, alpha: 1 }
    }
  })
    .composite([{ input: logoSplash, gravity: "center" }])
    .png()
    .toFile(path.join(assetsDir, "splash.png"));

  await fs.promises.copyFile(path.join(assetsDir, "splash.png"), path.join(assetsDir, "splash-dark.png"));

  console.log(
    "OK: official icon -> debtya-192.png, debtya-512.png, apple-touch-icon.png, favicon-32.png, public/logo.png, assets/logo.png, google-play-icon-512.png, splash.png"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
