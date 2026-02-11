param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$Token,

  [int]$IntervalSeconds = 25
)

Write-Host "Runtime heartbeat started. Ctrl+C to stop."

while ($true) {
  try {
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/runtime/presence" `
      -Headers @{ Authorization = "Bearer $Token" }

    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$now] presence ok: $($response.ok)"
  } catch {
    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$now] presence failed: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $IntervalSeconds
}

