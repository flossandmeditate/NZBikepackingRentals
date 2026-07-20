Set-Location "c:\Users\Chris\Dropbox\ChrisWebApps\DIRK BIKEPACKING"

$files = Get-ChildItem routes -Recurse -Filter '*.json' | Where-Object { $_.DirectoryName -notmatch '_json-backup-' }

$frontOrder = @(
  'id',
  'file',
  'rideWithGpsUrl',
  'name',
  'days',
  'distanceLabel',
  'totalElevationMeters',
  'surfaceSplit',
  'recommendedBike',
  'difficultyLevel',
  'difficulty'
)

foreach($f in $files){
  $obj = Get-Content -Raw $f.FullName | ConvertFrom-Json

  $moreInfoLinks = @()
  if($obj.PSObject.Properties.Name -contains 'moreInfo' -and $obj.moreInfo -ne $null){
    foreach($lnk in @($obj.moreInfo)){
      if($null -ne $lnk -and [string]::IsNullOrWhiteSpace([string]$lnk) -eq $false){
        $moreInfoLinks += [string]$lnk
      }
    }
  }

  $rideWithGpsUrl = $null
  if($obj.PSObject.Properties.Name -contains 'rideWithGpsUrl'){
    $candidate = [string]$obj.rideWithGpsUrl
    if($candidate -match 'ridewithgps\.com'){
      $rideWithGpsUrl = $candidate
    }
  }
  if(-not $rideWithGpsUrl){
    $rideWithGpsUrl = ($moreInfoLinks | Where-Object { $_ -match 'ridewithgps\.com' } | Select-Object -First 1)
  }

  $filteredMoreInfo = @($moreInfoLinks | Where-Object { $_ -notmatch 'ridewithgps\.com' })

  $ordered = [ordered]@{}
  foreach($k in $frontOrder){
    if($k -eq 'rideWithGpsUrl'){
      if($rideWithGpsUrl){ $ordered[$k] = $rideWithGpsUrl }
      continue
    }
    if($obj.PSObject.Properties.Name -contains $k){
      $ordered[$k] = $obj.$k
    }
  }

  # Always keep moreInfo present, now without Ride with GPS links.
  foreach($p in $obj.PSObject.Properties){
    if($p.Name -eq 'moreInfo'){
      $ordered['moreInfo'] = $filteredMoreInfo
      continue
    }
    if(-not $ordered.Contains($p.Name)){
      $ordered[$p.Name] = $p.Value
    }
  }

  if(-not $ordered.Contains('moreInfo')){
    $ordered['moreInfo'] = $filteredMoreInfo
  }

  $ordered | ConvertTo-Json -Depth 100 | Set-Content -Path $f.FullName -Encoding UTF8
}

"Migrated rideWithGpsUrl in $($files.Count) route files."
