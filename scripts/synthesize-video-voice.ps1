param(
  [Parameter(Mandatory = $true)][string]$InputTextPath,
  [Parameter(Mandatory = $true)][string]$OutputWavePath,
  [Parameter(Mandatory = $true)][ValidateSet('fr','en')][string]$Language
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($InputTextPath), [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 2500) { throw 'VIDEO_VOICE_TEXT_INVALID' }
$output = [System.IO.Path]::GetFullPath($OutputWavePath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($output)) | Out-Null
try {
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $culturePrefix = if ($Language -eq 'fr') { 'fr' } else { 'en' }
    $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith($culturePrefix) } | Select-Object -First 1
    if ($null -ne $voice) { $speaker.SelectVoice($voice.VoiceInfo.Name) }
    $speaker.Rate = 1
    $speaker.Volume = 100
    $speaker.SetOutputToWaveFile($output)
    $speaker.Speak($text)
  } finally {
    if ($null -ne $speaker) { $speaker.Dispose() }
  }
} catch {
  # Some Windows sandbox sessions cannot enumerate System.Speech voices even
  # though the desktop SAPI engine is available. Use the local COM engine as a
  # real offline fallback; no text leaves the machine.
  $sapiVoice = New-Object -ComObject SAPI.SpVoice
  $sapiStream = New-Object -ComObject SAPI.SpFileStream
  try {
    $sapiStream.Open($output, 3, $false)
    $sapiVoice.AudioOutputStream = $sapiStream
    $sapiVoice.Rate = 1
    $sapiVoice.Volume = 100
    [void]$sapiVoice.Speak($text)
  } finally {
    if ($null -ne $sapiStream) { $sapiStream.Close() }
  }
}
