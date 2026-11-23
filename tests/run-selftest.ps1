# Windows'ta debug sürümüyle uçtan uca sınama (WebView2 + paketteki ffmpeg.exe).
#   cd src-tauri; cargo build; cd ..; ./tests/run-selftest.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$media = Join-Path $root 'tests\media'
$work = Join-Path ([IO.Path]::GetTempPath()) ("kesit-sinama-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$script = Join-Path $work '.selftest.js'
$header = "const MEDIA = $($media | ConvertTo-Json);`nconst WORK = $($work | ConvertTo-Json);`n"
[IO.File]::WriteAllText($script, $header + [IO.File]::ReadAllText((Join-Path $root 'tests\selftest.js')), [Text.UTF8Encoding]::new($false))

$env:KESIT_SELFTEST = $script
$env:KESIT_FFMPEG = Join-Path $root 'src-tauri\bin\ffmpeg.exe'
$exe = Get-ChildItem (Join-Path $root 'src-tauri\target\debug') -Filter '*.exe' |
  Where-Object { $_.BaseName -ieq 'kesit' } | Select-Object -First 1
if (-not $exe) { throw 'Debug sürümü bulunamadı: önce src-tauri içinde cargo build çalıştır.' }

$out = Join-Path $work 'cikti.txt'
$p = Start-Process -FilePath $exe.FullName -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError (Join-Path $work 'hata.txt')
if (-not $p.WaitForExit(240000)) { $p.Kill(); Get-Content $out; throw 'Sınama zaman aşımına uğradı.' }
Get-Content $out -Encoding utf8
$last = (Get-Content $out -Encoding utf8 | Select-Object -Last 1)
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if ($last -notmatch '"fail":0') { throw "Sınama başarısız: $last" }
