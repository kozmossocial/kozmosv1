param(
  [string]$EnvFile = ".env.local"
)

$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()

$newKey = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
if ([string]::IsNullOrWhiteSpace($newKey)) {
  throw "Failed to generate bootstrap key."
}

if (-not (Test-Path $EnvFile)) {
  Set-Content -Path $EnvFile -Value "RUNTIME_BOOTSTRAP_KEY=$newKey"
} else {
  $content = Get-Content $EnvFile -Raw
  if ($content -match "(?m)^RUNTIME_BOOTSTRAP_KEY=") {
    $updated = [Regex]::Replace(
      $content,
      "(?m)^RUNTIME_BOOTSTRAP_KEY=.*$",
      "RUNTIME_BOOTSTRAP_KEY=$newKey"
    )
    Set-Content -Path $EnvFile -Value $updated
  } else {
    Add-Content -Path $EnvFile -Value "`nRUNTIME_BOOTSTRAP_KEY=$newKey"
  }
}

Write-Host "RUNTIME_BOOTSTRAP_KEY rotated in $EnvFile"
Write-Host "New key:"
Write-Host $newKey
Write-Host ""
Write-Host "Next steps:"
Write-Host "1) Update same key in Vercel Environment Variables."
Write-Host "2) Redeploy."
