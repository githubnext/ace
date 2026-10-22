# Desktop icons

`ace.svg` (green, stable and development) and `canary.svg` (yellow) are the sources. Each draws
Ace's mark, the `AceAvatar` hypotrochoid (`R` 4, scale 5.2, `d` 3, stroke 7 in its 100-unit box), at
6.4× on a superellipse (`n` 5) that follows Apple's 1024 grid: 824 wide, 100 in from each edge, so
the icon sits at the same size as other apps in the Dock.

The mark is sampled at 4096 points. `ace-avatar.svg` uses 360, which facets visibly at icon sizes.

Every PNG in an `.iconset` is rendered from its SVG at that PNG's own pixel size in Chrome (an `<img>`
screenshotted with a transparent background), not downscaled from 1024, so small sizes stay sharp.
Change an SVG, then re-render all ten sizes for both sets.

Electrobun selects the yellow set for canary and the green set for stable and development builds.
It compiles the selected set with macOS `iconutil`.
