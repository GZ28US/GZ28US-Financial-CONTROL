param([string]$name, [string]$orient = 'cols', [string]$old = '640,768,992,1152,1312,1664,1984,2464,2880,3392,3840,4320,4800,5216,5632,6016,6208', [string]$new = '640,768,992,1152,1312,1664,1984,2464,2880,3392,3840,4416,5008,5600,6192,6784,7488', [string]$hold = '1')
# Save the clipboard (Copy with Axis) as orig_<name>.txt, remap it onto the new rpm axis, put the values-only TSV back on the clipboard.
$d = 'C:\Users\gz28u\AppData\Local\Temp\claude\C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App\74703188-1640-416c-9a20-d16963e3b264\scratchpad\hm\r10'
$c = Get-Clipboard -Raw
if (-not $c -or $c -notmatch "`t") { Write-Output "CLIPBOARD EMPTY/INVALID"; exit 1 }
$c | Set-Content -Encoding utf8 -NoNewline "$d\orig_$name.txt"
$out = & node "$d\remap.mjs" "$d\orig_$name.txt" $orient $old $new $hold
$vals = ($out | Where-Object { $_ -notmatch '^#INFO' }) -join "`r`n"
$info = ($out | Where-Object { $_ -match '^#INFO' })
$vals | Set-Content -Encoding utf8 -NoNewline "$d\new_$name.tsv"
Set-Clipboard -Value $vals
Write-Output $info
Write-Output ("first row: " + (($vals -split "`r`n")[0]))
