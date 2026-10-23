# Ficha brand

## The mark

In Brazil a *ficha* is a token: the metal token for a public phone or an arcade machine. In Portugal a *ficha* is a plug. The mark shows both at once: a coin with a milled edge, turned three-quarters toward you, with the two round pins of a Schuko plug (CEE 7/4, type F) standing out of its face. The milled edge makes it a token and the pins make it a plug. Put together, the coin is the plug.

The mark is drawn flat. It uses three fills, with no strokes, no masks and no effects:

| Part | Fill |
|---|---|
| Coin face and pin tips | Brand gradient |
| Milled edge and pin shafts | Brand gradient, one step deeper |
| Gaps (face to edge, pins to face, reeding) | Real holes. The background shows through. |

Proportions (the coin diameter is 1): each pin is 0.15 across, the pins are 0.50 apart centre to centre, and each pin is 0.53 long with a slightly domed tip. The edge shows 16 reeds, sized so they still read at 48 px.

The palette, the gradient direction and the Montserrat wordmark are those of the Ficha app's design system.

## Colours

| Token | Hex | Use |
|---|---|---|
| `lime` | `#66E619` | Gradient top (dark backgrounds) |
| `cyan` | `#00C8EE` | Gradient bottom (dark backgrounds) |
| `lime-deep` | `#459A19` | Edge and shafts, top (lime mixed 35% toward navy) |
| `cyan-deep` | `#0287A4` | Edge and shafts, bottom (cyan mixed 35% toward navy) |
| `navy` | `#070D1A` | Dark background, wordmark on light backgrounds |
| `near-white` | `#F2F2F2` | Wordmark on dark backgrounds |
| `green-light` | `#00B130` | Gradient top (light backgrounds) |
| `teal-light` | `#00758E` | Gradient bottom (light backgrounds) |
| `green-light-deep` | `#027828` | Edge and shafts, top (light backgrounds) |
| `teal-light-deep` | `#025165` | Edge and shafts, bottom (light backgrounds) |

Every gradient runs straight down, from the top of the artwork to its bottom, top to bottom. Lime on white has a contrast ratio of only 1.6:1, so white and light backgrounds get their own files with the deeper pair.

The light-background pair starts on the app's light-theme green, `oklch(0.66 0.22 145)`, and ends on a deep teal, `oklch(0.52 0.11 220)`, so the green-to-cyan travel stays visible.

## Wordmark

The wordmark is **FICHA** in Montserrat Bold (700), with tracking of 0.05 em. It is converted to outlines, so it looks the same everywhere. Montserrat has no kerning pairs for these letters. The **C** carries the brand gradient: it is the round letter in the middle of the word, the coin inside the name. All other letters are near-white on dark backgrounds and navy on light ones.

In the lockup, the mark is 1.8 × the cap height (pins included). The centre of the coin face sits on the middle of the cap height, and the pins point toward the wordmark.

Never retype the wordmark in a live font. Use the lockup files.

## Clear space and minimum size

- **Clear space:** let *x* be the cap height of FICHA in the lockup (5/9 of the lockup height). Keep at least **x/2** clear on every side of the lockup. For the mark on its own, keep **1/4 of the mark's height** clear on every side.
- **Mark:** 48 px or larger on screen, 12 mm in print. Below 48 px the reeding turns to grey fuzz, so use a favicon file instead.
- **Favicon:** use `ficha-favicon.svg` from 16 to 32 px and `ficha-favicon-32.svg` from 24 to 47 px.
- **Lockup:** 48 px high or larger on screen, 15 mm in print. Below that, use the mark alone.

## Which file where

| File | Use it for |
|---|---|
| `ficha-mark.svg` | The mark on navy or other dark backgrounds, 48 px and up. Transparent 512 × 512. |
| `ficha-mark-light.svg` | The mark on white or light backgrounds. Uses the deeper pair, and the gaps are cut 1 unit narrower because white gaps look wider. |
| `ficha-mark-mono.svg` | One colour (`currentColor`). Use it for print in one ink, embossing, laser engraving and vinyl. The gaps are real holes, so white vinyl on a navy station makes a clean knock-out. Set the colour with CSS `color`, or replace `currentColor` with a colour value. |
| `ficha-favicon.svg` | Browser favicon (`<link rel="icon" type="image/svg+xml">`). Hinted on a 16 px grid, so it stays crisp at 16, 32 and 48. There is no milling, the pins are thicker, and the gaps are at least 1 px. |
| `ficha-favicon-32.svg` | The three-quarter coin without milling, for UI icons from 24 to 47 px and for the 32 px PNG. |
| `ficha-logo.svg` | The horizontal lockup on dark backgrounds. |
| `ficha-logo-light.svg` | The horizontal lockup on white or light backgrounds. |
| `ficha-app-icon.svg` | The app icon master: 1024 × 1024, full-bleed navy, with no corner rounding (the platform applies its own mask). Every point of the mark lies within 300 px of the centre, so it is safe inside the Android adaptive-icon circle (66/108) and under the iOS mask. It also works as a PWA `maskable` icon. |
| `png/ficha-app-icon-512x512.png` | PWA manifest icon and store listings. |
| `png/ficha-app-icon-192x192.png` | PWA manifest and Android home screen. |
| `png/ficha-app-icon-180x180.png` | `apple-touch-icon`. |
| `png/ficha-favicon-32x32.png`, `png/ficha-favicon-16x16.png` | Legacy favicon links and `.ico` builds. |

All the PNG files are rendered by headless Chrome from the SVGs above.

## Don'ts

- Don't recolour the mark outside these tokens.
- Don't add outlines, shadows, glows or bevels.
- Don't stretch the mark or redraw its parts.
- Don't put the gradient mark on a busy or mid-tone photo. Use the one-colour mark there.
- Don't move the gradient to a letter other than the C.
- Don't add earth clips or an inner ring to the coin face. Two pins inside a ring read as a face.
