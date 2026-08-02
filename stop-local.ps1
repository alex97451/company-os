Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
& npm.cmd run ops:stop-all
exit $LASTEXITCODE
