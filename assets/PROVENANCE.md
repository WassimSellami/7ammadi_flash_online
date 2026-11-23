# Asset provenance

All game art and audio below were copied from the sibling pygame project
`../7ammadi_flash_ai/data/` (permission: it is the same author's project; the
pygame project was intentionally not modified). They are served under the
versioned path `/v1/…` from this folder.

## Art — `v1/icons/`

| File | Source | Notes |
| --- | --- | --- |
| `bg.jpg` | `data/icons/bg.jpg` | arena background |
| `bria-rmbg3-cutout.png` / `.ico` | `data/icons/bria-rmbg3-cutout.png/.ico` | brush sprite; recoloured at runtime |
| `music.png` | `data/icons/music.png` | HUD toggle |
| `volume.png` | `data/icons/volume.png` | HUD toggle |
| `rain.png`, `boom.png`, `bandi.png`, `fat.png`, `speed.png`, `potion.png` | `data/icons/*.png` | prize icons |

`normal_A.png` / `normal_B.png` from the reference are not used (the brush is
recoloured per palette instead).

## Audio — `v1/sounds/`

The reference WAVs were converted to MP3 (mono 44.1 kHz, 96 kbps; music 128
kbps) to keep the PWA install small (~1.4 MB instead of ~17 MB). Source files
(lossless) remain in the pygame project.

`smash.mp3`, `punch.mp3`, `gun.mp3`, `bomb.mp3`, `beep.mp3`, `evil.mp3`,
`s_1.mp3`, `s_2.mp3`, `s_3.mp3`, `s_go.mp3`, `s_f_sc.mp3`, `s_sc.mp3`,
`play_music.mp3`.

`bg.jpg` was re-encoded at high quality (10.5 MB → ~1.9 MB) from the reference
`data/icons/bg.jpg`.

**Licensing caveat:** the origin/licence of `play_music` could not be verified
from the pygame project. Replace it with a track you have rights to before a
public launch. The short effects are assumed to be the author's own; verify
before distributing if that assumption is wrong.

## Font — `v1/fonts/`

Comic Neue Regular/Bold (`ComicNeue-*.ttf`) from Google Fonts, SIL Open Font
License 1.1. The licence text is included as `OFL.txt`. Comic Sans itself is
not bundled or served.

## PWA icons

`icon-192.png`, `icon-512.png`, `icon-maskable-512.png` are renditions of the
brush sprite on the game's dark background, generated from the copied art.
