# Project artwork

The icon is the T-Rex of Chrome's offline game redrawn as pixel art: its head and chest in the
app's amber `#f0a830` rising from the bottom of a dark `#181613` tile, drawn from the pixel map in
[`scripts/generate-brand.ts`](../../scripts/generate-brand.ts). Every size is the 192 px drawing
scaled (sampled eight times per pixel), so the favicon is the same picture as the home-screen icon.

Run `bun scripts/generate-brand.ts` after changing the art. It writes the app icons (plain and
maskable, one drawing: Chrome on macOS puts the maskable one in the Dock), the white-on-transparent notification
badge Android draws from alpha alone, the Apple touch icon, `favicon.png`, `favicon.ico` and the
1280 × 640 social preview with the pixel word "T-Rex" and a cursor. New icons need a new `?v=` query and
`CACHE_NAME` (`src/conventions.test.ts` says which).

GitHub's repository preview is a separate setting: open
[repository settings](https://github.com/alexanderkreidich/t-rex/settings), then **Social preview →
Edit → Upload an image** and select `public/social-preview.png`.
