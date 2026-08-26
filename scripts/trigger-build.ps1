param(
  [string]$Repo = 'round123/dealpilot-dsh',
  [string]$Ref = 'master',
  [string]$Sha = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Sha) { $Sha = (git rev-parse $Ref).Trim() }

Write-Host "Checking build workflow for $Sha..."
$runJson = gh run list --repo $Repo --workflow build.yml --commit $Sha --limit 1 --json databaseId,status,conclusion,url | ConvertFrom-Json
if (-not $runJson) {
  Write-Host 'No push-triggered run found; dispatching workflow manually.'
  $url = (gh workflow run build.yml --repo $Repo --ref $Ref)
  Write-Host $url
  Start-Sleep -Seconds 5
  $runJson = gh run list --repo $Repo --workflow build.yml --limit 1 --json databaseId,status,conclusion,url | ConvertFrom-Json
}

if (-not $runJson) {
  Start-Sleep -Seconds 5
  $runJson = gh run list --repo $Repo --workflow build.yml --limit 1 --json databaseId,status,conclusion,url | ConvertFrom-Json
}

if (-not $runJson) { throw 'Unable to locate the dispatched GitHub Actions run.' }
$run = @($runJson)[0]
Write-Host "Watching run $($run.databaseId): $($run.url)"
gh run watch $run.databaseId --repo $Repo --exit-status
