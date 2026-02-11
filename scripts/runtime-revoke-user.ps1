param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$BootstrapKey,

  [Parameter(Mandatory = $true)]
  [string]$Username
)

$body = @{
  revokeAllForUser = $true
  username = $Username
} | ConvertTo-Json

$res = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/runtime/token/revoke" `
  -Headers @{ "x-kozmos-bootstrap-key" = $BootstrapKey } `
  -ContentType "application/json" `
  -Body $body

Write-Host "Revoke result:"
$res | Format-List

