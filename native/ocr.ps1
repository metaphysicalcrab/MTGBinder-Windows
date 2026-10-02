# Binder's OCR helper on Windows (spec 5.1.4), the counterpart of native/ocr.swift: reads one JSON request per line on
# stdin, {"id": "...", "path": "..."}, reads that image with Windows OCR (Windows.Media.Ocr, through WinRT), and writes
# one JSON answer per line on stdout:
# {"id": "...", "width": 672, "height": 936, "lines": [{"text": "...", "confidence": 1,
#   "box": {"x": 0.06, "y": 0.04, "w": 0.5, "h": 0.04}}]}
# Boxes are normalized to the image with the origin at the top left. Windows OCR measures no confidence, so it's always
# 1 (the matcher doesn't read it). Failures answer {"id": "...", "error": "..."}; a line that isn't a request answers
# with the id "". It exits when stdin ends.
#
# It runs in Windows PowerShell 5.1 (powershell.exe, part of Windows 10 and 11; PowerShell 7 can't reach WinRT) and
# needs no building. Answers are written as ASCII bytes, anything else in them as \uXXXX, so no console code page can
# change them, and Binder sends its requests the same way. This file is ASCII too, which 5.1 reads alike in every code
# page (it reads a script without a byte order mark in the ANSI one).
#
# -Check answers one line about which languages Windows OCR reads on this PC, for `pnpm run setup`. -SelfTest checks the
# parts that don't need Windows (splitting lines, boxes, JSON), in any PowerShell.
param(
  [switch]$Check,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
# Progress records would reach a redirected stderr as CLIXML.
$ProgressPreference = 'SilentlyContinue'

# A line Windows OCR reads is split where the gap between two of its words is wider than this many times its tallest
# word. Vision reads a collector line's columns ("U 0201" and "TM & (c) 2023 Wizards of the Coast") as separate lines,
# and the matcher looks for a line that is only the collector number; it also keeps a title apart from its mana cost.
$GapFactor = 1.5
# A small image is enlarged to about this long a side, at most MaxUpscale times: Windows OCR misses text much under
# 15 px tall, and a collector line is 1.5% of a card's height (14 px on a 936 px image).
$TargetLongSide = 2400
$MaxUpscale = 2.5
# How long the WinRT calls for one image may take in all: under the server's 10 s, so a slow image is answered with an
# error rather than the helper being stopped.
$WaitMs = 8000

$AsTask = $null
$Engine = $null
$Deadline = [DateTime]::UtcNow
# Why this PowerShell can't read images at all; every request is answered with it.
$Unavailable = $null

# A JSON string in pure ASCII: quotes and backslashes escaped, and every character outside 0x20-0x7E as \uXXXX.
function ConvertTo-JsonString([string]$Text) {
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  foreach ($char in $Text.ToCharArray()) {
    $code = [int]$char
    if ($code -eq 34 -or $code -eq 92) { [void]$builder.Append('\').Append($char) }
    elseif ($code -ge 0x20 -and $code -le 0x7E) { [void]$builder.Append($char) }
    else { [void]$builder.Append('\u').Append($code.ToString('x4')) }
  }
  [void]$builder.Append('"')
  $builder.ToString()
}

# A number as JSON: at most 5 decimals, with a point whatever this PC's language, and 0 for what JSON has no number
# for (NaN, the infinities).
function ConvertTo-JsonNumber([double]$Value) {
  if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { return '0' }
  $rounded = [Math]::Round($Value, 5)
  if ($rounded -eq 0) { return '0' }
  $rounded.ToString('0.#####', [Globalization.CultureInfo]::InvariantCulture)
}

# Splits one line's words (objects with Text, and X, Y, W and H in pixels) into runs, left to right, wherever the gap
# between two words is wider than GapFactor times the tallest. Returns an array of arrays of words.
function Split-Words($Words) {
  $sorted = @($Words | Sort-Object -Property X)
  $tallest = 0.0
  foreach ($word in $sorted) { if ($word.H -gt $tallest) { $tallest = $word.H } }
  $runs = New-Object Collections.Generic.List[object]
  $run = New-Object Collections.Generic.List[object]
  $right = 0.0
  foreach ($word in $sorted) {
    if ($run.Count -gt 0 -and ($word.X - $right) -gt $GapFactor * $tallest) {
      $runs.Add($run.ToArray())
      $run = New-Object Collections.Generic.List[object]
    }
    if ($run.Count -eq 0 -or $word.X + $word.W -gt $right) { $right = $word.X + $word.W }
    $run.Add($word)
  }
  if ($run.Count -gt 0) { $runs.Add($run.ToArray()) }
  , $runs.ToArray()
}

# A value kept between 0 and 1.
function Limit-Unit([double]$Value) {
  [Math]::Min(1.0, [Math]::Max(0.0, $Value))
}

# The box around some words, normalized to a Width x Height image and kept within it.
function Get-WordsBox($Words, [double]$Width, [double]$Height) {
  $left = [double]::MaxValue
  $top = [double]::MaxValue
  $right = [double]::MinValue
  $bottom = [double]::MinValue
  foreach ($word in $Words) {
    $left = [Math]::Min($left, [double]$word.X)
    $top = [Math]::Min($top, [double]$word.Y)
    $right = [Math]::Max($right, [double]$word.X + $word.W)
    $bottom = [Math]::Max($bottom, [double]$word.Y + $word.H)
  }
  $x0 = Limit-Unit ($left / $Width)
  $y0 = Limit-Unit ($top / $Height)
  $x1 = Limit-Unit ($right / $Width)
  $y1 = Limit-Unit ($bottom / $Height)
  @{ x = $x0; y = $y0; w = $x1 - $x0; h = $y1 - $y0 }
}

# One line of an answer: a run of words, their text joined with spaces, and the box around them.
function ConvertTo-LineJson($Words, [double]$Width, [double]$Height) {
  $box = Get-WordsBox $Words $Width $Height
  $text = ($Words | ForEach-Object { $_.Text }) -join ' '
  '{"text":' + (ConvertTo-JsonString $text) + ',"confidence":1,"box":{"x":' + (ConvertTo-JsonNumber $box.x) +
    ',"y":' + (ConvertTo-JsonNumber $box.y) + ',"w":' + (ConvertTo-JsonNumber $box.w) +
    ',"h":' + (ConvertTo-JsonNumber $box.h) + '}}'
}

function ConvertTo-AnswerJson([string]$Id, [int]$Width, [int]$Height, $LineJson) {
  $invariant = [Globalization.CultureInfo]::InvariantCulture
  '{"id":' + (ConvertTo-JsonString $Id) + ',"width":' + $Width.ToString($invariant) +
    ',"height":' + $Height.ToString($invariant) + ',"lines":[' + ($LineJson -join ',') + ']}'
}

function ConvertTo-FailureJson([string]$Id, [string]$Message) {
  '{"id":' + (ConvertTo-JsonString $Id) + ',"error":' + (ConvertTo-JsonString $Message) + '}'
}

# Writes one line to stdout as ASCII bytes, straight to the stream (Write-Output would go through the console's code
# page, and Write-Host lands on stdout too).
function Send-Line([string]$Line) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($Line + "`n")
  $Stdout.Write($bytes, 0, $bytes.Length)
  $Stdout.Flush()
}

# Disposes what can be, quietly: a failure to let go of memory mustn't fail an image that was read.
function Close-Object($Object) {
  if ($Object -is [IDisposable]) { try { $Object.Dispose() } catch { } }
}

# The message of what went wrong, from the innermost exception: a WinRT failure arrives wrapped twice over.
function Get-Reason($Failure) {
  $exception = $Failure.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $exception.Message
}

# How much to scale an image whose long side is Long pixels: a small one up to about TargetLongSide (at most
# MaxUpscale times), and never past MaxDimension, the most the engine takes (OcrEngine.MaxImageDimension).
function Get-Scale([double]$Long, [double]$MaxDimension) {
  if ($Long -le 0) { return 1.0 }
  $scale = 1.0
  if ($Long -lt $TargetLongSide) { $scale = [Math]::Min($MaxUpscale, $TargetLongSide / $Long) }
  if ($Long * $scale -gt $MaxDimension) { $scale = $MaxDimension / $Long }
  $scale
}

function Initialize-WindowsRuntime {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [System.IO.WindowsRuntimeStreamExtensions]
  # PowerShell can't await a WinRT operation, nor call the generic AsTask on one itself (it can't tell the result's
  # type), so the method is found here and made for each result type in Wait-Operation.
  $script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
}

# Waits for a WinRT operation's result, until the image's deadline.
function Wait-Operation($Operation, [Type]$ResultType) {
  $task = $AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $left = [Math]::Max(1, [int]($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if (-not $task.Wait($left)) { throw ('Windows OCR took longer than ' + ($WaitMs / 1000) + ' s') }
  $task.Result
}

# What to do when Windows OCR can't read English here.
function Get-MissingEnglish {
  $arrow = ' ' + [char]0x2192 + ' '
  $tags = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $installed = $tags -join ', '
  if (-not $installed) { $installed = 'none' }
  "Windows OCR can't read English on this PC (it reads: $installed). Add English (United States) in Settings" +
    $arrow + 'Time & language' + $arrow + 'Language & region, or install only its text recognition: in PowerShell ' +
    "as administrator, run Add-WindowsCapability -Online -Name 'Language.OCR~~~en-US~0.0.1.0'. Then scan again."
}

# Windows OCR's English recognizer: en-US, else any English one Windows has (en-GB reads cards as well). Throws what to
# do when there's none, and looks again at the next image, so installing English works without restarting Binder.
function Get-Engine {
  if ($null -ne $Unavailable) { throw $Unavailable }
  if ($null -ne $script:Engine) { return $script:Engine }
  $unitedStates = New-Object Windows.Globalization.Language 'en-US'
  $recognizer = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($unitedStates)
  if ($null -eq $recognizer) {
    foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      if ($language.LanguageTag -like 'en*') {
        $recognizer = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
      }
      if ($null -ne $recognizer) { break }
    }
  }
  if ($null -eq $recognizer) { throw (Get-MissingEnglish) }
  $script:Engine = $recognizer
  $recognizer
}

# Decodes the image at the given scale, upright: its EXIF orientation applied (a phone can store a photo sideways), as
# BGRA. Swap gives the scaled width and height the other way round.
function Get-ScaledBitmap($Decoder, [double]$Scale, [bool]$Swap) {
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  if ($Scale -ne 1) {
    $width = [Math]::Max(1, [Math]::Floor($Decoder.PixelWidth * $Scale))
    $height = [Math]::Max(1, [Math]::Floor($Decoder.PixelHeight * $Scale))
    if ($Swap) { $width, $height = $height, $width }
    $transform.ScaledWidth = [uint32]$width
    $transform.ScaledHeight = [uint32]$height
    if ($Scale -gt 1) { $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic }
    else { $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant }
  }
  $format = [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8
  $alpha = [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
  $orientation = [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation
  $color = [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
  $operation = $Decoder.GetSoftwareBitmapAsync($format, $alpha, $transform, $orientation, $color)
  Wait-Operation $operation ([Windows.Graphics.Imaging.SoftwareBitmap])
}

# The image as Windows OCR reads it: upright, and scaled by Get-Scale.
function Get-Bitmap($Decoder) {
  $long = [Math]::Max($Decoder.OrientedPixelWidth, $Decoder.OrientedPixelHeight)
  $scale = Get-Scale $long ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  $bitmap = Get-ScaledBitmap $Decoder $scale $false
  # Whether the scaled size is taken before or after the EXIF rotation isn't documented: a sideways photo that comes
  # out with its sides the wrong way round is decoded again with them swapped.
  $turned = $Decoder.OrientedPixelWidth -ne $Decoder.PixelWidth
  $wide = $Decoder.OrientedPixelWidth -gt $Decoder.OrientedPixelHeight
  if ($scale -ne 1 -and $turned -and ($bitmap.PixelWidth -gt $bitmap.PixelHeight) -ne $wide) {
    Close-Object $bitmap
    $bitmap = Get-ScaledBitmap $Decoder $scale $true
  }
  $bitmap
}

# Reads the text in the image at Path, as the answer to request Id.
function Read-Card([string]$Id, [string]$Path) {
  $recognizer = Get-Engine
  $script:Deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
  $memory = $null
  $stream = $null
  $bitmap = $null
  try {
    try {
      # Read whole into memory, so no handle is kept on the file: Binder deletes it once the scan is added or discarded.
      $memory = [IO.MemoryStream]::new([IO.File]::ReadAllBytes($Path))
      $stream = [IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
      $decoding = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
      $decoder = Wait-Operation $decoding ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Get-Bitmap $decoder
    } catch {
      throw ("Can't read an image at " + $Path + ' (' + (Get-Reason $_) + ')')
    }
    try {
      $result = Wait-Operation ($recognizer.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } catch {
      throw ('Text recognition failed: ' + (Get-Reason $_))
    }
    $lines = New-Object Collections.Generic.List[string]
    foreach ($ocrLine in $result.Lines) {
      $words = @(foreach ($ocrWord in $ocrLine.Words) {
        $rect = $ocrWord.BoundingRect
        [pscustomobject]@{ Text = $ocrWord.Text; X = $rect.X; Y = $rect.Y; W = $rect.Width; H = $rect.Height }
      })
      if ($words.Count -eq 0) { continue }
      foreach ($run in (Split-Words $words)) {
        $lines.Add((ConvertTo-LineJson $run $bitmap.PixelWidth $bitmap.PixelHeight))
      }
    }
    ConvertTo-AnswerJson $Id $decoder.OrientedPixelWidth $decoder.OrientedPixelHeight $lines.ToArray()
  } finally {
    Close-Object $bitmap
    Close-Object $stream
    Close-Object $memory
  }
}

# The id and path of a request line, or null when it isn't one.
function Read-Request([string]$Line) {
  try { $parsed = ConvertFrom-Json -InputObject $Line } catch { return $null }
  if ($null -eq $parsed) { return $null }
  $id = $parsed.id
  $file = $parsed.path
  if ($id -isnot [string] -or $file -isnot [string]) { return $null }
  @{ Id = $id; Path = $file }
}

# Checks the parts that don't need Windows on made-up words. Returns how many checks failed.
function Invoke-SelfTest {
  $tally = @{ run = 0; failed = 0 }
  $expect = {
    param([string]$Name, $Actual, $Expected)
    $tally.run++
    if ([string]$Actual -ceq [string]$Expected) { Send-Line ('ok   ' + $Name) }
    else {
      $tally.failed++
      Send-Line ('FAIL ' + $Name + "`n       expected: " + $Expected + "`n       actual:   " + $Actual)
    }
  }
  $word = { param($Text, $X, $Y, $W, $H) [pscustomobject]@{ Text = $Text; X = $X; Y = $Y; W = $W; H = $H } }
  $texts = { param($Runs) ($Runs | ForEach-Object { ($_ | ForEach-Object { $_.Text }) -join ' ' }) -join ' | ' }

  # A 2020s card's collector line, read by Windows OCR as one line, its words out of order.
  $collector = @(
    (& $word 'TM' 600 900 24 20), (& $word 'U' 40 900 12 20), (& $word '0201' 60 898 50 24),
    (& $word '&' 630 900 12 20), (& $word '2023' 648 900 44 20)
  )
  & $expect 'splits a line at a wide gap, left to right' (& $texts (Split-Words $collector)) 'U 0201 | TM & 2023'
  $title = @((& $word 'Lightning' 50 40 150 40), (& $word 'Bolt' 215 40 80 40), (& $word 'R' 900 40 30 30))
  & $expect 'keeps a title apart from its mana cost' (& $texts (Split-Words $title)) 'Lightning Bolt | R'
  $gap = @((& $word 'a' 0 0 10 20), (& $word 'b' 40 0 10 20), (& $word 'c' 81 0 10 20))
  & $expect 'splits only past 1.5 times the tallest word' (& $texts (Split-Words $gap)) 'a b | c'
  & $expect 'leaves a one-word line whole' (& $texts (Split-Words @((& $word 'Instant' 10 10 90 20)))) 'Instant'

  $box = Get-WordsBox @((& $word 'U' 40 900 12 20), (& $word '0201' 60 898 50 24)) 1000 1400
  $boxText = (@($box.x, $box.y, $box.w, $box.h) | ForEach-Object { ConvertTo-JsonNumber $_ }) -join ' '
  & $expect 'boxes a run of words, normalized to the image' $boxText '0.04 0.64143 0.07 0.01714'
  $outside = Get-WordsBox @((& $word 'wide' -5 -2 1010 30)) 1000 1400
  $outsideText = (@($outside.x, $outside.y, $outside.w) | ForEach-Object { ConvertTo-JsonNumber $_ }) -join ' '
  & $expect 'keeps a box within the image' $outsideText '0 0 1'

  $odd = 'J' + [char]0xF6 + 'tun "Grunt" \ ' + [char]0x2022 + [char]0x2605 + [char]0xA9 + [char]0x2122 + "`t`n"
  $escaped = '"J\u00f6tun \"Grunt\" \\ \u2022\u2605\u00a9\u2122\u0009\u000a"'
  & $expect 'writes JSON strings in ASCII' (ConvertTo-JsonString $odd) $escaped
  $numbers = @(0.5, (1 / 3), 0.0000001, [double]::NaN, [double]::PositiveInfinity, -0.0, 2400) |
    ForEach-Object { ConvertTo-JsonNumber $_ }
  & $expect 'writes JSON numbers' ($numbers -join ' ') '0.5 0.33333 0 0 0 0 2400'
  $culture = [Threading.Thread]::CurrentThread.CurrentCulture
  try {
    [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::new('de-DE')
    $german = (0.5).ToString() -eq '0,5'
  } catch { $german = $false }
  if ($german) { & $expect 'writes a point in a language that writes a comma' (ConvertTo-JsonNumber 0.5) '0.5' }
  [Threading.Thread]::CurrentThread.CurrentCulture = $culture

  $scales = @(@(1370, 10000), @(936, 10000), @(2400, 10000), @(4000, 2600), @(1100, 2600), @(1000, 2000)) |
    ForEach-Object { ConvertTo-JsonNumber (Get-Scale $_[0] $_[1]) }
  & $expect 'enlarges small images, within the most the engine takes' ($scales -join ' ') '1.75182 2.5 1 0.65 2.18182 2'

  $line = ConvertTo-LineJson @((& $word ('Zo' + [char]0xEB) 40 900 12 20)) 1000 1400
  $answer = ConvertTo-AnswerJson ('7' + [char]0x2605) 1000 1400 @($line, $line)
  & $expect 'writes an answer in ASCII' ($answer -cmatch '^[\x20-\x7e]+$') 'True'
  $parsed = ConvertFrom-Json $answer
  $read = @($parsed.id, $parsed.width, $parsed.lines.Count, $parsed.lines[0].text, $parsed.lines[0].box.x) -join ' '
  & $expect 'writes an answer that JSON reads back' $read ('7' + [char]0x2605 + ' 1000 2 Zo' + [char]0xEB + ' 0.04')
  $request = Read-Request '{"id":"3","path":"C:\\Users\\Zo\u00eb\\12.jpg"}'
  & $expect 'reads a request' ($request.Id + ' ' + $request.Path) ('3 C:\Users\Zo' + [char]0xEB + '\12.jpg')
  $notRequests = @((Read-Request 'nonsense'), (Read-Request '5'), (Read-Request '{"id":3,"path":"x"}'))
  & $expect "doesn't take what isn't a request" ($notRequests -join '|') '||'
  # The answer itself, for the test that runs this to read as Binder does.
  Send-Line $answer

  if ($tally.failed -gt 0) { Send-Line ('FAILED ' + $tally.failed + ' of ' + $tally.run + ' checks') }
  else { Send-Line ('passed ' + $tally.run + ' checks') }
  $tally.failed
}

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  # Device policy (WDAC or AppLocker) runs this script in Constrained Language mode, which allows neither WinRT nor the
  # console's streams. So it says why through Write-Output (in ASCII, which the console's code page can't change), as
  # the answer to the request it was started for, and stops: each image the server sends starts it again.
  $blocked = "This PC's device policy runs PowerShell in " + $ExecutionContext.SessionState.LanguageMode +
    " mode, which keeps Binder from using Windows OCR. Ask whoever manages this PC to allow Binder's OCR helper."
  if ($Check) {
    Write-Output ('{"languages":[],"english":null,"error":"' + $blocked + '"}')
    exit 0
  }
  Write-Output ('{"id":"","error":"' + $blocked + '"}')
  exit 1
}

$Stdout = [Console]::OpenStandardOutput()

if ($SelfTest) {
  if ((Invoke-SelfTest) -gt 0) { exit 1 }
  exit 0
}

# 5.0, on the first Windows 10 builds, has no PSEdition, and is Windows PowerShell too.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $Unavailable = "Binder's OCR helper runs in Windows PowerShell 5.1 (powershell.exe), which can reach Windows OCR; " +
    'PowerShell ' + $PSVersionTable.PSVersion + " can't."
} else {
  try {
    Initialize-WindowsRuntime
  } catch {
    $Unavailable = "Windows OCR isn't available on this PC: " + (Get-Reason $_)
  }
}

if ($Check) {
  # One line of JSON: the languages Windows OCR reads here, the English one Binder reads cards in, and what to do when
  # there's none.
  $languages = @()
  $english = $null
  $problem = $null
  try {
    if ($null -ne $Unavailable) { throw $Unavailable }
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    $english = (Get-Engine).RecognizerLanguage.LanguageTag
  } catch {
    $problem = Get-Reason $_
  }
  $tags = ($languages | ForEach-Object { ConvertTo-JsonString $_ }) -join ','
  $englishJson = 'null'
  if ($null -ne $english) { $englishJson = ConvertTo-JsonString $english }
  $problemJson = 'null'
  if ($null -ne $problem) { $problemJson = ConvertTo-JsonString $problem }
  Send-Line ('{"languages":[' + $tags + '],"english":' + $englishJson + ',"error":' + $problemJson + '}')
  exit 0
}

# PowerShell may already have begun reading stdin into Console.In, so requests are read from there, in the console's
# code page: Binder sends them in ASCII, which every code page reads alike.
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  $request = Read-Request $line
  if ($null -eq $request) {
    $shown = $line
    if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) }
    Send-Line (ConvertTo-FailureJson '' ('Not a request: ' + $shown))
    continue
  }
  try {
    Send-Line (Read-Card $request.Id $request.Path)
  } catch {
    Send-Line (ConvertTo-FailureJson $request.Id (Get-Reason $_))
  }
}
exit 0
