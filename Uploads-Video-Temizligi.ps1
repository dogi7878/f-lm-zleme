$ErrorActionPreference = "Stop"

# Run this script from the project root, where the "artifacts" folder exists.
$uploadsRoot = Join-Path $PSScriptRoot "artifacts\api-server\uploads"
$videoRoot = Join-Path $uploadsRoot "videos"

Write-Host ""
Write-Host "BIRLIKTE IZLE - GUVENLI VIDEO TEMIZLIGI" -ForegroundColor Cyan
Write-Host "--------------------------------------"

if (-not (Test-Path -LiteralPath $videoRoot -PathType Container)) {
    Write-Host "HATA: Video klasoru bulunamadi:" -ForegroundColor Red
    Write-Host "  $videoRoot"
    Write-Host ""
    Write-Host "Bu .ps1 dosyasini projenin kok klasorune koyup oradan calistir."
    Read-Host "Cikmak icin Enter'a bas"
    exit 1
}

# Only list direct files inside uploads\videos. Do not touch subfolders or .tmp.
$files = @(Get-ChildItem -LiteralPath $videoRoot -File)
if ($files.Count -eq 0) {
    Write-Host "Video klasorunde silinecek dosya bulunamadi." -ForegroundColor Yellow
    Read-Host "Cikmak icin Enter'a bas"
    exit 0
}

$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
$totalGB = [math]::Round($totalBytes / 1GB, 2)

Write-Host ""
Write-Host "Video klasoru: $videoRoot"
Write-Host ("Bulunan dosya: {0}" -f $files.Count)
Write-Host ("Toplam boyut : {0} GB" -f $totalGB)
Write-Host ""
Write-Host "Silinecek dosyalar:" -ForegroundColor Yellow
$files | Sort-Object Length -Descending | Select-Object `
    @{Name="Dosya";Expression={$_.Name}},
    @{Name="Boyut_MB";Expression={[math]::Round($_.Length / 1MB, 1)}} |
    Format-Table -AutoSize

Write-Host "ONEMLI: Bu islem videos klasorundeki dosyalari kalici olarak siler." -ForegroundColor Red
Write-Host "Kodlara, veritabani dosyalarina ve uploads\.tmp klasorune dokunulmayacak."
Write-Host "Video dosyalarinin bilgisayarinda baska yerde oldugunu kontrol et."
Write-Host ""
$confirmation = Read-Host "Devam etmek icin TAM OLARAK VIDEOLARI SIL yaz"

if ($confirmation -cne "VIDEOLARI SIL") {
    Write-Host "Iptal edildi. Hicbir dosya silinmedi." -ForegroundColor Green
    Read-Host "Cikmak icin Enter'a bas"
    exit 0
}

# Re-check that the target directory is still the expected path.
$resolvedRoot = (Resolve-Path -LiteralPath $videoRoot).Path
$expectedSuffix = [IO.Path]::DirectorySeparatorChar + "uploads" + [IO.Path]::DirectorySeparatorChar + "videos"
if (-not $resolvedRoot.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Guvenlik kontrolu basarisiz; silme yapilmadi." -ForegroundColor Red
    Read-Host "Cikmak icin Enter'a bas"
    exit 1
}

$deleted = 0
$failed = 0
foreach ($file in $files) {
    try {
        Remove-Item -LiteralPath $file.FullName -Force
        $deleted++
    } catch {
        $failed++
        Write-Host ("Silinemedi: {0} -- {1}" -f $file.Name, $_.Exception.Message) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("Silinen dosya: {0}" -f $deleted) -ForegroundColor Green
Write-Host ("Silinemeyen dosya: {0}" -f $failed)
Write-Host ("Beklenen bosalan alan: yaklasik {0} GB" -f $totalGB)
Write-Host ""
Write-Host "Not: Site odalarinda bu videolara ait baglantilar varsa artik acilmayabilir."
Write-Host ".tmp klasoru bilerek temizlenmedi."
Read-Host "Bitirmek icin Enter'a bas"
