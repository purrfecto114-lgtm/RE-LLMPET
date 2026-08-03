# Meme and cat-skin asset provenance

## Imported upstream revision

Repository: `myunwang/LLMPET`

Commit: `49fef749364b31dfa2ddab857aed7d82d49460cc`

Imported on: 2026-07-28

The following files were copied byte-for-byte. No image or audio conversion was performed.

| Upstream path | Destination | SHA-256 |
|---|---|---|
| `shared/i18n.js` | `frontend/shared/i18n.js` | `6b00997e12df957546f9ddb9498915041c3ecdd36b165106ca693052f55de7bc` |
| `assets/memes/catalog.json` | `resources/memes/catalog.json` | `c49f3188a36ce2184876c2adb1973022c33c1f79355b54a566934b802625b46a` |
| `assets/memes/huaqiang-guaranteed/visual.gif` | `frontend/assets/memes/huaqiang-guaranteed/visual.gif` | `071b250823da30d6bdf80891a61cf5debe674f4e19cd8df35079d41cbe172481` |
| `assets/memes/huaqiang-guaranteed/voice.mp3` | `frontend/assets/memes/huaqiang-guaranteed/voice.mp3` | `acd1b3d4a066d7a7d2d72a1fe3c2a15585c81ae3b95b12ae70b2fc25dcdf560d` |
| `assets/memes/ni-gan-ma/visual.gif` | `frontend/assets/memes/ni-gan-ma/visual.gif` | `485ae2c4aacd3b3c7a41b141ad31b58f6b3457b3c9c1fe9efd962dcf439f232f` |
| `assets/memes/ni-gan-ma/voice.mp3` | `frontend/assets/memes/ni-gan-ma/voice.mp3` | `c45cbb45b263d470781b41de8c1247841183d8f674a4559ca39d54cb23cb0c29` |
| `assets/cat/CREDITS.md` | `frontend/assets/cat/CREDITS.md` | `b49c4ec367f5a212e25f9bc8e79010f3999b2d81073c785a9b1d7b1873a8ab25` |

Machine-readable provenance is in `reports/upstream-import-provenance.json`.

## Renderer exposure policy

The exact catalog is retained as a backend resource because it includes complete prompt/instruction bodies. `scripts/generate-public-meme-catalog.js` validates it and emits a deterministic `frontend/shared/memes.js` containing presentation-only data. The generated manifest intentionally excludes prompt text and is checked by `npm run gate:memes`.

The current Tauri UI provides an honest local GIF/audio preview. It does not claim to dispatch a meme prompt to an agent. Full dispatch is deferred until provider/session ownership can be enforced in Rust.

## Attribution and redistribution caution

The upstream repository is MIT-licensed, but a repository license does not necessarily establish redistribution rights for every third-party image or audio embedded in it. The cat-skin upstream attribution identifies the original creator as Douyin account `@月薪喵` and says commercial use should obtain authorization. Preserve `frontend/assets/cat/CREDITS.md` in source and binary distributions.

The two action GIF/MP3 pairs should receive a separate rights review before public or commercial redistribution. Until that review is complete, treat them as upstream-preserved development assets rather than proof of cleared commercial rights.
