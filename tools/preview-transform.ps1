param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [Parameter(Mandatory = $true)][string]$StudioDir,
  [Parameter(Mandatory = $true)][string]$TemplatePath,
  [Parameter(Mandatory = $true)][string]$InputPath
)

$ErrorActionPreference = 'Stop'

function Write-Result {
  param(
    [bool]$Ok,
    [string]$Output = '',
    [string]$Message = ''
  )

  [pscustomobject]@{
    ok = $Ok
    output = $Output
    message = $Message
  } | ConvertTo-Json -Compress
}

try {
  if (-not (Test-Path -LiteralPath $StudioDir)) {
    Write-Output (Write-Result -Ok $false -Message "Studio directory not found: $StudioDir")
    exit 0
  }

  if (-not (Test-Path -LiteralPath $TemplatePath)) {
    Write-Output (Write-Result -Ok $false -Message "Template file not found: $TemplatePath")
    exit 0
  }

  if (-not (Test-Path -LiteralPath $InputPath)) {
    Write-Output (Write-Result -Ok $false -Message "Input file not found: $InputPath")
    exit 0
  }

  Set-Location -LiteralPath $StudioDir
  [Environment]::CurrentDirectory = $StudioDir

  Get-ChildItem -LiteralPath $StudioDir -Filter *.dll | ForEach-Object {
    try { [void][System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($_.FullName)) } catch {}
  }

  $coreAssembly = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'Core' } | Select-Object -First 1
  if (-not $coreAssembly) {
    $corePath = Join-Path $StudioDir 'Core.dll'
    $coreAssembly = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($corePath))
  }

  $template = [System.IO.File]::ReadAllText($TemplatePath)
  $inputJson = [System.IO.File]::ReadAllText($InputPath)

  if ($Mode -eq 'merge') {
    $type = $coreAssembly.GetType('Core.BusinessRules.MergeCodes.RazorMergeDocumentBuilder', $true, $false)
    $instance = [Activator]::CreateInstance($type)
    $model = $inputJson | ConvertFrom-Json
    $output = $type.GetMethod('SearchAndReplace').Invoke($instance, @($template, [object]$model))
    Write-Output (Write-Result -Ok $true -Output ([string]$output))
    exit 0
  }

  $jsonType = $coreAssembly.GetType('Core.BusinessRules.MergeCodes.RazorJsonMergeDocumentBuilder', $true, $false)
  $jsonInstance = [Activator]::CreateInstance($jsonType)
  $jsonOutput = $jsonType.GetMethod('SearchAndReplace').Invoke($jsonInstance, @($template, [object]$inputJson))
  Write-Output (Write-Result -Ok $true -Output ([string]$jsonOutput))
  exit 0
}
catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) {
    $message = $message + ' | ' + $_.Exception.InnerException.Message
  }
  Write-Output (Write-Result -Ok $false -Message $message)
  exit 0
}


