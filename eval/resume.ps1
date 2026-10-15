# Relaunch the eval rotation as detached background processes (safe to rerun: finished rows are skipped).
# Usage: powershell -NoProfile -File eval/resume.ps1
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path "$root\eval\logs" | Out-Null
foreach ($m in @("openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b")) {
  $log = "$root\eval\logs\" + ($m -replace '[/.]', '_') + ".log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm -s eval:run --model $m --wait >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
}
