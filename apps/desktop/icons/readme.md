# Desktop icons

`ace.icon` (green: stable and development) and `canary.icon` (yellow) are Icon Composer documents
and the source of truth. Both use `mark.svg`, Ace's mark as the site shows it: the `AceAvatar`
hypotrochoid at the shape `ace-avatar.svg` uses (`d` 3.175, scale 5.515), stroke 6.4, and tilted 7°
counter-clockwise. It was rendered at 8× and traced into one filled path with potrace, so Icon
Composer can fill it. `ace-avatar.svg`'s 360-segment polyline facets at icon sizes.

Electrobun compiles an `.iconset` with `iconutil`, so each PNG is rendered from the `.icon` with
Icon Composer's `ictool` at 824/1024 of the PNG's size. It's then centred with a soft shadow
(30% black, blur 12/1024, offset 6/1024 down), matching the margin of the legacy `.icns` that
`actool` writes. `actool` stops at 256 px, so it can't supply the iconset itself.

```sh
ictool=/Applications/Icon\ Composer.app/Contents/Executables/ictool
"$ictool" ace.icon --export-image --output-file body.png --platform macOS --rendition Default \
	--width 824 --height 824 --scale 1
```

After editing an `.icon`, render all ten sizes for both sets again.
