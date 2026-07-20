[CmdletBinding()]
param(
	[string]$InputDir = "routes",
	[string]$OutputDir = "",
	[double]$IntervalKm = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DistanceMeters {
	param(
		[double]$Lat1,
		[double]$Lon1,
		[double]$Lat2,
		[double]$Lon2
	)

	$R = 6371000.0
	$dLat = ($Lat2 - $Lat1) * [Math]::PI / 180.0
	$dLon = ($Lon2 - $Lon1) * [Math]::PI / 180.0
	$a = [Math]::Sin($dLat / 2.0) * [Math]::Sin($dLat / 2.0) +
			 [Math]::Cos($Lat1 * [Math]::PI / 180.0) * [Math]::Cos($Lat2 * [Math]::PI / 180.0) *
			 [Math]::Sin($dLon / 2.0) * [Math]::Sin($dLon / 2.0)
	$c = 2.0 * [Math]::Atan2([Math]::Sqrt($a), [Math]::Sqrt(1.0 - $a))
	return $R * $c
}

function New-Point {
	param(
		[double]$Lat,
		[double]$Lon,
		[Nullable[double]]$Ele = $null
	)

	return [pscustomobject]@{
		Lat = $Lat
		Lon = $Lon
		Ele = $Ele
	}
}

function Parse-Points {
	param([xml]$Doc)

	$nodes = $Doc.SelectNodes("//*[local-name()='trkpt']")
	$points = [System.Collections.Generic.List[object]]::new()

	foreach($node in $nodes) {
		$latAttr = $node.Attributes["lat"]
		$lonAttr = $node.Attributes["lon"]
		if(-not $latAttr -or -not $lonAttr) { continue }

		$lat = 0.0
		$lon = 0.0
		if(-not [double]::TryParse($latAttr.Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$lat)) { continue }
		if(-not [double]::TryParse($lonAttr.Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$lon)) { continue }

		$eleNode = $node.SelectSingleNode("./*[local-name()='ele']")
		$eleVal = $null
		if($eleNode) {
			$eleParsed = 0.0
			if([double]::TryParse($eleNode.InnerText, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$eleParsed)) {
				$eleVal = [double]$eleParsed
			}
		}

		$points.Add((New-Point -Lat $lat -Lon $lon -Ele $eleVal))
	}

	return $points
}

function Build-SampledPoints {
	param(
		[System.Collections.Generic.List[object]]$Points,
		[double]$IntervalMeters
	)

	$sampled = [System.Collections.Generic.List[object]]::new()
	if($Points.Count -eq 0) { return $sampled }

	$sampled.Add($Points[0])
	if($Points.Count -eq 1) { return $sampled }

	$nextAt = $IntervalMeters
	$cum = 0.0

	for($i = 1; $i -lt $Points.Count; $i++) {
		$a = $Points[$i - 1]
		$b = $Points[$i]
		$seg = Get-DistanceMeters -Lat1 $a.Lat -Lon1 $a.Lon -Lat2 $b.Lat -Lon2 $b.Lon
		if($seg -le 0.0) {
			continue
		}

		while(($cum + $seg) -ge $nextAt) {
			$ratio = ($nextAt - $cum) / $seg
			$lat = $a.Lat + (($b.Lat - $a.Lat) * $ratio)
			$lon = $a.Lon + (($b.Lon - $a.Lon) * $ratio)

			$ele = $null
			if($a.Ele -ne $null -and $b.Ele -ne $null) {
				$ele = [double]$a.Ele + (([double]$b.Ele - [double]$a.Ele) * $ratio)
			}

			$sampled.Add((New-Point -Lat $lat -Lon $lon -Ele $ele))
			$nextAt += $IntervalMeters
		}

		$cum += $seg
	}

	$last = $Points[$Points.Count - 1]
	$existingLast = $sampled[$sampled.Count - 1]
	if([Math]::Abs($existingLast.Lat - $last.Lat) -gt 0.000001 -or [Math]::Abs($existingLast.Lon - $last.Lon) -gt 0.000001) {
		$sampled.Add($last)
	}

	return $sampled
}

function Get-TrackName {
	param([xml]$Doc, [string]$Fallback)

	$nameNode = $Doc.SelectSingleNode("//*[local-name()='trk']/*[local-name()='name']")
	if($nameNode -and $nameNode.InnerText.Trim()) {
		return $nameNode.InnerText.Trim()
	}
	return $Fallback
}

function Write-PreviewGpx {
	param(
		[string]$OutputPath,
		[string]$TrackName,
		[System.Collections.Generic.List[object]]$Points
	)

	$settings = New-Object System.Xml.XmlWriterSettings
	$settings.Indent = $true
	$settings.IndentChars = "  "
	$settings.Encoding = [System.Text.UTF8Encoding]::new($false)

	$writer = [System.Xml.XmlWriter]::Create($OutputPath, $settings)
	try {
		$writer.WriteStartDocument()
		$writer.WriteStartElement("gpx", "http://www.topografix.com/GPX/1/1")
		$writer.WriteAttributeString("version", "1.1")
		$writer.WriteAttributeString("creator", "DIRK Preview GPX Generator")

		$writer.WriteStartElement("trk")
		$writer.WriteElementString("name", $TrackName)
		$writer.WriteStartElement("trkseg")

		foreach($pt in $Points) {
			$writer.WriteStartElement("trkpt")
			$writer.WriteAttributeString("lat", ([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:0.000000}", $pt.Lat)))
			$writer.WriteAttributeString("lon", ([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:0.000000}", $pt.Lon)))
			if($pt.Ele -ne $null) {
				$writer.WriteElementString("ele", [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:0.0}", [double]$pt.Ele))
			}
			$writer.WriteEndElement()
		}

		$writer.WriteEndElement()
		$writer.WriteEndElement()
		$writer.WriteEndElement()
		$writer.WriteEndDocument()
	}
	finally {
		$writer.Dispose()
	}
}

$repoRoot = (Get-Location).Path
$inPath = Join-Path $repoRoot $InputDir
$outPath = if([string]::IsNullOrWhiteSpace($OutputDir)) { $null } else { Join-Path $repoRoot $OutputDir }
$intervalMeters = $IntervalKm * 1000.0

if(-not (Test-Path -LiteralPath $inPath)) {
	throw "Input directory not found: $inPath"
}

if($outPath -and -not (Test-Path -LiteralPath $outPath)) {
	New-Item -ItemType Directory -Path $outPath -Force | Out-Null
}

$files = Get-ChildItem -Path $inPath -Filter *.gpx -File -Recurse |
	Where-Object { $_.Name -notlike '*.preview.gpx' } |
	Sort-Object FullName
if($files.Count -eq 0) {
	throw "No GPX files found in $inPath"
}

$results = [System.Collections.Generic.List[object]]::new()

foreach($file in $files) {
	[xml]$doc = Get-Content -Path $file.FullName -Raw
	$allPoints = Parse-Points -Doc $doc
	if($allPoints.Count -lt 2) {
		Write-Warning "Skipping $($file.Name): not enough points"
		continue
	}

	$sampled = Build-SampledPoints -Points $allPoints -IntervalMeters $intervalMeters
	if($sampled.Count -lt 2) {
		Write-Warning "Skipping $($file.Name): sampled output too small"
		continue
	}

	$trackName = Get-TrackName -Doc $doc -Fallback $file.BaseName
	$previewName = "{0}.preview.gpx" -f $file.BaseName
	$outputFile = if($outPath) {
		Join-Path $outPath $previewName
	} else {
		Join-Path $file.DirectoryName $previewName
	}
	Write-PreviewGpx -OutputPath $outputFile -TrackName $trackName -Points $sampled

	$inSize = (Get-Item -LiteralPath $file.FullName).Length
	$outSize = (Get-Item -LiteralPath $outputFile).Length
	$results.Add([pscustomobject]@{
		File = $file.FullName.Substring($repoRoot.Length + 1).Replace('\\','/')
		SourceKB = [Math]::Round($inSize / 1KB, 1)
		Preview = $outputFile.Substring($repoRoot.Length + 1).Replace('\\','/')
		PreviewKB = [Math]::Round($outSize / 1KB, 1)
		Points = $sampled.Count
		Reduction = [Math]::Round((1.0 - ($outSize / [double]$inSize)) * 100.0, 1)
	})
}

$results | Sort-Object File | Format-Table -AutoSize
