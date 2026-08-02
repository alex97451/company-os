Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
& npm.cmd run ops:start-all @args
exit $LASTEXITCODE
