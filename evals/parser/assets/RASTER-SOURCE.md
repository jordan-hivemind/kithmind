# Canonical scan raster sources

The two PNG files in this directory are the exact RGB image pixels embedded in
the frozen, scored image-only PDF fixtures. They were decoded losslessly from
the single image XObject in each committed PDF after the corpus was frozen.
They contain wholly synthetic text rendered from the vendored Noto Sans font.

The first generator revision rendered these pixels through Pillow. Linux CI
generated different raster PDF bytes despite pinned Python, Pillow, and font
versions; the four native PDFs reproduced exactly. Canonical pixels remove
platform-dependent font rasterization from fixture regeneration. The PNGs are now the
canonical generator inputs. The generator verifies their hashes and authored
content metadata before embedding them. It does not render their text.

| Asset                      | Size and mode   | SHA-256                                                            | Frozen PDF SHA-256                                                 |
| -------------------------- | --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `image-clear-raster.png`   | 1600 x 2100 RGB | `7955240518de843118da2606f3f04ee264b0af375c65774db242fcce671253ee` | `6811f16380161235ed57a1cdd9e6e6e5fe89ee494542bc006e33fc7ac1e45add` |
| `image-partial-raster.png` | 1600 x 2100 RGB | `35f2b6c95c2d05c408432493cb71632366c697e75e5dedd901c4173a868917ea` | `b07ba209ed26959a31658c7d717d69d811b145688f2b5722e849703546234cf1` |

The font remains covered by the OFL files already present in this directory.
The synthetic pixel arrangement has no additional third-party source.
