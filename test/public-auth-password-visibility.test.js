const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("V135 oculta por defecto todas las contrasenas", () => {
  for (const id of ["authPassword", "authPasswordConfirm", "pwRecoveryNew", "pwRecoveryConfirm"]) {
    assert.match(indexSource, new RegExp(`id="${id}"[\\s\\S]{0,220}?type="password"`));
    assert.match(indexSource, new RegExp(`data-password-target="${id}"`));
  }
});

test("V135 permite ver u ocultar sin enviar ni guardar la contrasena", () => {
  const start = appSource.indexOf("function syncPasswordVisibilityButtons");
  const end = appSource.indexOf("function setBankExchangeFlag", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const visibilitySource = appSource.slice(start, end);

  assert.match(visibilitySource, /input\.type === "password" \? "text" : "password"/);
  assert.match(visibilitySource, /button\.setAttribute\("aria-pressed"/);
  assert.match(visibilitySource, /input\.value = "";/);
  assert.equal(visibilitySource.includes("fetch("), false);
  assert.equal(visibilitySource.includes("api("), false);
  assert.equal(visibilitySource.includes("localStorage"), false);
  assert.equal(visibilitySource.includes("sessionStorage"), false);
});

test("V135 elimina el cambio automatico inseguro y usa etiquetas accesibles", () => {
  assert.equal(appSource.includes("wireAuthPasswordMaskBehavior"), false);
  assert.match(appSource, /password_show: "Show password"/);
  assert.match(appSource, /password_hide: "Hide password"/);
  assert.match(appSource, /password_show: "Mostrar contraseña"/);
  assert.match(appSource, /password_hide: "Ocultar contraseña"/);
});
