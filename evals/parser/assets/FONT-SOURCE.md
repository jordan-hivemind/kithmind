# Fixture font source

The fixture fonts and their licenses were copied from the official Google Fonts
repository at commit
`5e35378e6bda803962ee6fd257e444a7d459660d`.

| Asset                          | Repository path                                     | SHA-256                                                            |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| `NotoSans.ttf`                 | `ofl/notosans/NotoSans[wdth,wght].ttf`              | `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d` |
| `OFL-NotoSans.txt`             | `ofl/notosans/OFL.txt`                              | `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a` |
| `NotoSansSymbols2-Regular.ttf` | `ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf` | `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21` |
| `OFL-NotoSansSymbols2.txt`     | `ofl/notosanssymbols2/OFL.txt`                      | `b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0` |

The fixture generator verifies both font hashes before writing any PDF. Noto
Sans supplies Latin and BMP Unicode text. Noto Sans Symbols 2 supplies the
supplementary-plane globe marker used to exercise UTF-16 evidence offsets.
