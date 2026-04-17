$ErrorActionPreference = "Stop"
Write-Host "== Security preflight (DebtYa API) ==" -ForegroundColor Cyan

$trackedEnv = @(git ls-files -- .env 2>$null)
if ($trackedEnv.Count -gt 0) {
  Write-Host "[FAIL] .env esta versionado en git (no deberia). Ejecuta: git rm --cached .env" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] .env no esta en el indice de git" -ForegroundColor Green

$trackedNm = @(git ls-files node_modules 2>$null)
if ($trackedNm.Count -gt 0) {
  Write-Host "[WARN] node_modules sigue teniendo archivos trackeados; ejecuta git rm -r --cached node_modules" -ForegroundColor Yellow
} else {
  Write-Host "[OK] node_modules no esta trackeado" -ForegroundColor Green
}

$envHistory = git rev-list --all -1 -- .env 2>$null
if ($LASTEXITCODE -eq 0 -and $envHistory) {
  Write-Host "[WARN] .env aparece en historial (commit $envHistory). Revisa rotacion de secretos en PROJECT_EXECUTION_PLAN.md" -ForegroundColor Yellow
} else {
  Write-Host "[OK] Sin commit conocido con .env en historial (o repo shallow)" -ForegroundColor Green
}

Write-Host "Listo." -ForegroundColor Cyan
