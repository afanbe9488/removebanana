# 🍌 RemoveBanana

**Remove invisible AI watermarks from Google Gemini-generated images using reverse alpha blending mathematics.**

[![npm version](https://img.shields.io/npm/v/removebanana)](https://www.npmjs.com/package/removebanana)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Don't want to self-host?** Use our free online tool: **[removebanana.eu.cc](https://removebanana.eu.cc)** — No sign-up, unlimited usage, 100% browser-based! 🚀

---

## What is this?

Google's AI image generators (Gemini, Imagen 2, Imagen 3, Nano Banana) embed invisible **SynthID** watermarks into every generated image. These watermarks are invisible to the human eye but can be detected by automated systems.

RemoveBanana uses the **exact mathematical inverse** of Google's alpha blending formula to perfectly reconstruct the original pixels — no AI guessing, no quality loss.

```
Gemini adds:     watermarked = α × logo + (1 - α) × original
We reverse it:   original = (watermarked - α × logo) / (1 - α)
```

## Supported Models

- ✅ Google Gemini (all versions)
- ✅ Imagen 2
- ✅ Imagen 3
- ✅ Nano Banana AI

## Installation

```bash
npm install removebanana canvas
```

> **Note:** The `canvas` package ([node-canvas](https://github.com/Automattic/node-canvas)) is required for Node.js usage. It provides the Canvas API that the engine needs for image processing.

## Quick Start

### Remove watermark from a file

```javascript
const { removeWatermark } = require('removebanana');

// Simple usage — output saved as input_clean.png
await removeWatermark('./gemini-image.png');

// With custom output path
await removeWatermark('./input.png', './output.png');

// With options
await removeWatermark('./input.jpg', './output.jpg', {
  format: 'jpeg',
  quality: 0.95,
  silent: false
});
```

### Remove watermark from a Buffer

```javascript
const { removeWatermarkFromBuffer } = require('removebanana');
const fs = require('fs');

const inputBuffer = fs.readFileSync('./gemini-image.png');
const { buffer, meta } = await removeWatermarkFromBuffer(inputBuffer, {
  format: 'png'
});

fs.writeFileSync('./clean-image.png', buffer);
console.log('Watermark info:', meta.watermark);
```

### Use in an Express API

```javascript
const express = require('express');
const multer = require('multer');
const { removeWatermarkFromBuffer } = require('removebanana');

const app = express();
const upload = multer();

app.post('/api/remove-watermark', upload.single('image'), async (req, res) => {
  const { buffer } = await removeWatermarkFromBuffer(req.file.buffer, {
    format: 'png',
    silent: true
  });
  
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

app.listen(3000, () => console.log('API running on port 3000'));
```

## API Reference

### `removeWatermark(inputPath, [outputPath], [options])`

Remove watermark from a file and save the result.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputPath` | `string` | Path to the input image |
| `outputPath` | `string` | (Optional) Output path. Defaults to `input_clean.ext` |
| `options.format` | `string` | Output format: `'png'`, `'jpeg'`, `'webp'` |
| `options.quality` | `number` | Quality for lossy formats (0-1, default: 0.95) |
| `options.silent` | `boolean` | Suppress console output |

**Returns:** `Promise<{ outputPath: string, meta: Object }>`

### `removeWatermarkFromBuffer(inputBuffer, [options])`

Remove watermark from a Buffer and return the result as a Buffer.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inputBuffer` | `Buffer` | Input image buffer |
| `options` | `Object` | Same options as `removeWatermark` |

**Returns:** `Promise<{ buffer: Buffer, meta: Object }>`

## How It Works

1. **Detect** — Identifies the watermark size (48×48 or 96×96) and position using template correlation
2. **Extract Alpha Map** — Calculates the watermark's alpha channel from reference templates
3. **Adaptive Detection** — Uses coarse-to-fine template matching for non-standard positions
4. **Reverse Blend** — Applies the inverse alpha blending formula to reconstruct original pixels
5. **Recalibrate** — Fine-tunes alpha gain and sub-pixel alignment for perfect removal

## Online Tool

**Don't want to install anything?** Use our free online tool:

🌐 **[removebanana.eu.cc](https://removebanana.eu.cc)**

- 100% browser-based — your images never leave your device
- No sign-up required
- Unlimited usage
- All formats supported (PNG, JPEG, WebP)

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/removebanana/removebanana).

## Support the Project

If this tool saved you time, consider supporting us:

☕ **[Buy Me a Coffee](https://www.buymeacoffee.com/removebanana)**

## License

MIT © [RemoveBanana](https://removebanana.eu.cc)

---

<p align="center">
  <b>🍌 Made with love by RemoveBanana</b><br>
  <a href="https://removebanana.eu.cc">removebanana.eu.cc</a>
</p>
