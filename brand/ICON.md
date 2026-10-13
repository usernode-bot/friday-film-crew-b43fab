# Friday Film Crew brand artwork

One flat film clapperboard mark, drawn to the Homeroom brand framework.
No text, no gradients, no shadows, no outlines.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | Source of the app icon. |
| `icon.png` | **The app icon**, set as `icon.image` in `dapp.json`. 1024×1024. Yellow clapperboard on a black full-bleed square. The platform rounds and crops it itself, so the tile has square corners. |
| `featured-light.svg` / `featured-light.png` | Featured artwork for the directory, light look. Black clapperboard on cream. Same mark geometry as the app icon, drawn larger (about 70% of the tile width). 1024×1024. |
| `featured-dark.svg` / `featured-dark.png` | Featured artwork for the directory, dark look. Yellow clapperboard on black, matching the app icon. Same geometry and scale as the light version. 1024×1024. |

The SVGs are the sources; the PNGs are rendered from them (a headless
Chromium viewport screenshot at device scale 1, 1024×1024, background set
to the tile colour). `icon.png` is the only file the app references;
the featured pair is kept here, ready to attach to the directory listing.
The emoji 🎬 stays set in `dapp.json` as the fallback if the image ever
fails to load.

## The mark

A flat clapperboard: a rounded board body, a striped top band, and a
striped clapper bar hinged at the board's top-left and raised 14 degrees.
The band is separated from the body by a gap in the tile colour. Three
parallelogram stripes on the clapper and three on the band, in the tile
colour, wide enough to stay distinct at 32 px. No words or letters.

## Colours (Homeroom brand palette)

| File | Mark | Tile | Pairing |
| --- | --- | --- | --- |
| `icon` / featured dark | `#FFEE6F` Yellow | `#000000` Black | Black + Yellow |
| featured light | `#000000` Black | `#FFFEEA` Cream | Cream + Black |
