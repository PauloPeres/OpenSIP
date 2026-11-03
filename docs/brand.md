# OpenSIP brand / Identidade visual

## English

**Mark.** A round speech bubble with a tail at the lower left, with three rounded vertical bars cut out of it (a voice level meter). Reads as "voice conversation" without using a handset. Geometric, 64-unit grid, flat colour, no gradients or shadows.

**Files** (all hand-written SVG, no fonts, no rasters)
- `assets/logo-mark.svg` - icon-only mark, transparent background, `viewBox="0 0 64 64"`, accent colour.
- `assets/logo-wordmark.svg` - mark + "OpenSIP", `viewBox="0 0 240 64"`. Lettering is drawn as stroked geometric paths (stroke width 4.5), so it renders identically everywhere. Text colour follows `prefers-color-scheme` (ink on light, off-white on dark) when the SVG is opened in a browser or used via `<img>`.
- `assets/logo.svg` - primary lockup; currently identical to the wordmark.
- `build/icon.png` (1024), `build/icon.iconset/`, `build/icon.icns` - generated app icon (white mark on an accent tile). Do not edit by hand.

**Palette**

| Name | Hex | Use |
|---|---|---|
| Signal Teal (accent) | `#0E9F8E` | Mark, app icon tile, primary actions |
| Ink | `#0B1F26` | Wordmark on light backgrounds |
| Paper | `#F4F7F7` | Wordmark on dark backgrounds |
| White | `#FFFFFF` | Mark on the icon tile |

The teal tile is mid-tone, so it keeps contrast on both light and dark Docks.

**Clear space.** Keep at least the width of one bar (7 units, about 11% of the mark width) free on all sides; for the wordmark use the height of the letter "O" outline (about 25 units).

**Minimum size.** Mark: 16 px (app icon) / 24 px (inline). Wordmark: 96 px wide. At 16 and 32 px the app icon is redrawn by the script with ONE centre bar (not three) and whole-pixel edges; three bars are used from 64 px up. The tile is a continuous-curvature squircle (straight edges plus superellipse corners, fitted against a stock macOS icon outline), not a plain rounded rectangle.

**Mark or wordmark.** Use the wordmark in the README and wherever there is horizontal room (app header, about screen). Use the mark alone where space is square or small (Dock, tray, favicon, avatar). One-colour use is supported: fill the mark with any single colour; the bars stay transparent.

**Do not** recolour outside the palette, add gradients, shadows, outlines or glows, rotate, stretch, put the teal mark on a similar teal background, add text inside the app icon, or redraw the lettering in another typeface.

**Regenerate rasters**

```
npx electron scripts/assets/render-icons.mjs
```

Suggested `package.json` script: `"render:icons": "electron scripts/assets/render-icons.mjs"`. If `NODE_OPTIONS` contains `--openssl-legacy-provider`, run with `env -u NODE_OPTIONS` (Electron rejects it). Requires macOS (`iconutil`). The script reads `assets/logo-mark.svg` for the 64+ px sizes; the 16/32 px variant is defined inside the script.

## Português

**Marca.** Um balão de fala redondo, com cauda no canto inferior esquerdo e três barras verticais arredondadas vazadas (medidor de nível de voz). Comunica "conversa por voz" sem usar o fone clássico. Geométrica, grade de 64 unidades, cor chapada, sem gradientes nem sombras.

**Arquivos** (SVG escrito à mão, sem fontes nem rasters)
- `assets/logo-mark.svg` - somente a marca, fundo transparente, `viewBox="0 0 64 64"`, cor de destaque.
- `assets/logo-wordmark.svg` - marca + "OpenSIP", `viewBox="0 0 240 64"`. As letras são caminhos geométricos com traço (largura 4,5), por isso renderizam igual em qualquer lugar. A cor do texto segue `prefers-color-scheme` (tinta no claro, off-white no escuro).
- `assets/logo.svg` - versão principal; hoje idêntica ao wordmark.
- `build/icon.png` (1024), `build/icon.iconset/`, `build/icon.icns` - ícone do app gerado (marca branca sobre quadrado de destaque). Não editar à mão.

**Paleta**

| Nome | Hex | Uso |
|---|---|---|
| Signal Teal (destaque) | `#0E9F8E` | Marca, quadrado do ícone, ações primárias |
| Ink | `#0B1F26` | Wordmark em fundos claros |
| Paper | `#F4F7F7` | Wordmark em fundos escuros |
| Branco | `#FFFFFF` | Marca sobre o quadrado do ícone |

O quadrado teal tem tom médio e mantém contraste em Docks claros e escuros.

**Área de respiro.** Pelo menos a largura de uma barra (7 unidades, cerca de 11% da largura da marca) livre em todos os lados; no wordmark, a altura do contorno do "O" (cerca de 25 unidades).

**Tamanho mínimo.** Marca: 16 px (ícone do app) / 24 px (em linha). Wordmark: 96 px de largura. Em 16 e 32 px o ícone é redesenhado pelo script com UMA barra central (não três) e bordas em pixels inteiros; três barras valem de 64 px para cima. O quadrado é um squircle de curvatura contínua (bordas retas + cantos superelípticos, ajustado contra o contorno de um ícone padrão do macOS), não um retângulo arredondado simples.

**Marca ou wordmark.** Use o wordmark no README e onde houver espaço horizontal (cabeçalho do app, tela "sobre"). Use só a marca em espaços quadrados ou pequenos (Dock, bandeja, favicon, avatar). Uso em uma cor é suportado: preencha a marca com uma única cor; as barras continuam transparentes.

**Não faça**: cores fora da paleta, gradientes, sombras, contornos ou brilhos, rotação, distorção, marca teal sobre fundo teal parecido, texto dentro do ícone do app, nem redesenhar as letras com outra fonte.

**Regenerar os rasters**

```
npx electron scripts/assets/render-icons.mjs
```

Script sugerido para o `package.json`: `"render:icons": "electron scripts/assets/render-icons.mjs"`. Se `NODE_OPTIONS` tiver `--openssl-legacy-provider`, rode com `env -u NODE_OPTIONS` (o Electron rejeita). Requer macOS (`iconutil`). O script lê `assets/logo-mark.svg` para os tamanhos de 64 px ou mais; a variante de 16/32 px fica definida dentro do script.
