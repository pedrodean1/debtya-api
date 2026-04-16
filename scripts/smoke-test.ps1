param(
  [Parameter(Mandatory = $true)]
  [string]$ApiBaseUrl,

  [string]$AuthToken = "",
  [string]$DebtId = ""
)

$ErrorActionPreference = "Stop"

function Invoke-ApiGet {
  param(
    [string]$Url,
    [string]$Token = ""
  )

  $headers = @{}
  if ($Token -and $Token.Trim().Length -gt 0) {
    $headers["Authorization"] = "Bearer $Token"
  }

  return Invoke-WebRequest -Method GET -Uri $Url -Headers $headers
}

function Assert-Status {
  param(
    [string]$Name,
    [int]$StatusCode
  )

  if ($StatusCode -ge 200 -and $StatusCode -lt 300) {
    Write-Host "[OK] $Name -> HTTP $StatusCode" -ForegroundColor Green
    return
  }

  throw "[FAIL] $Name -> HTTP $StatusCode"
}

$base = $ApiBaseUrl.TrimEnd("/")
Write-Host "== Smoke test DebtYa API ==" -ForegroundColor Cyan
Write-Host "Base URL: $base"

# 1) Health check
$health = Invoke-ApiGet -Url "$base/health"
Assert-Status -Name "/health" -StatusCode $health.StatusCode

# 2) Payment trace (optional, only if DebtId provided)
if ($DebtId -and $DebtId.Trim().Length -gt 0) {
  $trace = Invoke-ApiGet -Url "$base/payment-trace?debt_id=$DebtId" -Token $AuthToken
  Assert-Status -Name "/payment-trace" -StatusCode $trace.StatusCode
} else {
  Write-Host "[SKIP] /payment-trace (falta DebtId)" -ForegroundColor Yellow
}

Write-Host "Smoke test finalizado correctamente." -ForegroundColor Green
