/**
 * Rasteriza public/icons/debtya-brand.svg a PNGs (PWA, favicon, apple-touch, logo cuadrado).
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
const svgPath = path.join(root, "public", "icons", "debtya-brand.svg");
const svg = fs.readFileSync(svgPath);

async function main() {
  const iconsDir = path.join(root, "public", "icons");
  const assetsDir = path.join(root, "assets");
  const publicDir = path.join(root, "public");

  await sharp(svg).resize(192, 192).png().toFile(path.join(iconsDir, "debtya-192.png"));
  await sharp(svg).resize(512, 512).png().toFile(path.join(iconsDir, "debtya-512.png"));
  await sharp(svg).resize(180, 180).png().toFile(path.join(iconsDir, "apple-touch-icon.png"));
  await sharp(svg).resize(32, 32).png().toFile(path.join(iconsDir, "favicon-32.png"));
  await sharp(svg).resize(1024, 1024).png().toFile(path.join(publicDir, "logo.png"));
  await sharp(svg).resize(1024, 1024).png().toFile(path.join(assetsDir, "logo.png"));

  const logoSplash = await sharp(svg).resize(820, 820).png().toBuffer();
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

  console.log("OK: debtya-192.png, debtya-512.png, apple-touch-icon.png, favicon-32.png, public/logo.png, assets/logo.png, splash.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
