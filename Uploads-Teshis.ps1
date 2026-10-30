param(
  [string]$ProjectPath = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$Uploads = Join-Path $ProjectPath "artifacts\api-server\uploads"
if (-not (Test-Path -LiteralPath $Uploads -PathType Container)) {
  Write-Host "uploads klasoru bulunamadi: $Uploads" -ForegroundColor Red
  exit 1
}

$Report = Join-Path $ProjectPath "_uploads-diagnosis"
New-Item -ItemType Directory -Path $Report -Force | Out-Null

Write-Host "Bu arac SILME veya DEGISTIRME yapmaz." -ForegroundColor Yellow
Write-Host "Uploads: $Uploads"
Write-Host ""

$files = Get-ChildItem -LiteralPath $Uploads -Recurse -File -Force -ErrorAction SilentlyContinue |
  ForEach-Object {
    $rel = $_.FullName.Substring($Uploads.Length).TrimStart('\','/')
    $top = ($rel -split '[\\/]')[0]
    [PSCustomObject]@{
      RelativePath = $rel
      TopFolder = $top
      SizeBytes = [int64]$_.Length
      SizeMB = [math]::Round($_.Length / 1MB, 2)
      Extension = $_.Extension.ToLowerInvariant()
      LastWriteTime = $_.LastWriteTime
    }
  }

$files | Sort-Object SizeBytes -Descending |
  Export-Csv -LiteralPath (Join-Path $Report "all-upload-files.csv") -NoTypeInformation -Encoding UTF8

$files | Sort-Object SizeBytes -Descending | Select-Object -First 50 |
  Export-Csv -LiteralPath (Join-Path $Report "largest-upload-files.csv") -NoTypeInformation -Encoding UTF8

$files | Group-Object TopFolder | ForEach-Object {
  $sum = ($_.Group | Measure-Object -Property SizeBytes -Sum).Sum
  [PSCustomObject]@{
    Folder = $_.Name
    FileCount = $_.Count
    SizeGB = [math]::Round($sum / 1GB, 3)
    SizeMB = [math]::Round($sum / 1MB, 2)
    OldestFile = ($_.Group | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime
    NewestFile = ($_.Group | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  }
} | Sort-Object SizeMB -Descending |
  Export-Csv -LiteralPath (Join-Path $Report "upload-folder-sizes.csv") -NoTypeInformation -Encoding UTF8

Write-Host "Klasor boyutlari:" -ForegroundColor Green
Import-Csv (Join-Path $Report "upload-folder-sizes.csv") | Format-Table -AutoSize
Write-Host ""
Write-Host "En buyuk 20 dosya:" -ForegroundColor Green
$files | Sort-Object SizeBytes -Descending | Select-Object -First 20 RelativePath, SizeMB, Extension, LastWriteTime | Format-Table -AutoSize
Write-Host ""
Write-Host "Rapor klasoru: $Report"
Write-Host "Raporlari incelemeden hicbir dosyayi silme."
