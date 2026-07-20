$historyRoot = "C:\Users\Chris\AppData\Roaming\Code\User\History"
$index = Get-Content -Raw "data\routes-index.json" | ConvertFrom-Json

function Get-PropCount($obj){
    if($null -eq $obj){ return 0 }
    return @($obj.PSObject.Properties).Count
}

$allHistory = Get-ChildItem $historyRoot -Recurse -Filter "*.json" -File -ErrorAction SilentlyContinue
$restored = @()
$missing = @()

foreach($entry in $index.routes){
    $routeId = [string]$entry.id
    $target = Join-Path "routes" (Join-Path $routeId $entry.file)

    $bestObj = $null
    $bestScore = -1

    foreach($hf in $allHistory){
        $raw = $null
        try { $raw = Get-Content -Raw $hf.FullName -ErrorAction Stop } catch { continue }
        if([string]::IsNullOrWhiteSpace($raw)){ continue }
        if(($raw -notmatch ('"id"\s*:\s*"' + [regex]::Escape($routeId) + '"'))){ continue }

        $parsed = $null
        try { $parsed = $raw | ConvertFrom-Json -ErrorAction Stop } catch { continue }

        $candidates = @()
        if($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])){
            foreach($item in $parsed){
                if($null -ne $item -and [string]$item.id -eq $routeId){ $candidates += $item }
            }
        } else {
            if($null -ne $parsed -and [string]$parsed.id -eq $routeId){ $candidates += $parsed }
        }

        foreach($cand in $candidates){
            $score = Get-PropCount $cand
            $fileVal = [string]$cand.file
            if($fileVal -like "routes/$routeId/*"){ $score += 40 }
            if($fileVal -like "*/$routeId/*"){ $score += 20 }
            if($cand.PSObject.Properties.Name -contains 'totalElevationMeters'){ $score += 20 }
            if($cand.PSObject.Properties.Name -contains 'distanceLabel'){ $score += 15 }
            if($cand.PSObject.Properties.Name -contains 'routeSummary'){ $score += 10 }
            if($cand.PSObject.Properties.Name -contains 'recommendedBike'){ $score += 10 }

            if($score -gt $bestScore){
                $bestScore = $score
                $bestObj = $cand
            }
        }
    }

    if($null -eq $bestObj){
        $missing += $routeId
        continue
    }

    $targetDir = Split-Path -Parent $target
    if(-not (Test-Path $targetDir)){
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    $bestObj | ConvertTo-Json -Depth 100 | Set-Content -Path $target -Encoding UTF8
    $restored += [PSCustomObject]@{
        id = $routeId
        target = $target
        score = $bestScore
        props = (Get-PropCount $bestObj)
    }
}

"Restored: $($restored.Count) routes"
$restored | Sort-Object id | Format-Table -AutoSize
if($missing.Count -gt 0){
    "Missing: $($missing -join ', ')"
}
