/**
 * RemoveBanana — Remove AI watermarks from Gemini images
 * 
 * 🍌 Free online tool: https://removebanana.eu.cc
 * 📦 GitHub: https://github.com/removebanana/removebanana
 * 
 * @module removebanana
 */

const path = require('path');

// Print a friendly one-time message
let _printed = false;
function printBanner() {
    if (_printed) return;
    _printed = true;
    console.log('🍌 RemoveBanana v1.0.0 — Free AI Watermark Remover');
    console.log('   Online tool: https://removebanana.eu.cc');
    console.log('   GitHub: https://github.com/removebanana/removebanana');
    console.log('');
}

// Lazy-load canvas module and polyfill Node.js globals
let _canvas = null;
function getCanvas() {
    if (_canvas) return _canvas;
    try {
        _canvas = require('canvas');
        // Polyfill ImageData for Node.js (not available globally)
        if (typeof globalThis.ImageData === 'undefined' && _canvas.ImageData) {
            globalThis.ImageData = _canvas.ImageData;
        }
    } catch (e) {
        throw new Error(
            'RemoveBanana requires "canvas" package for Node.js usage.\n' +
            'Install it with: npm install canvas\n' +
            'Or use our free online tool: https://removebanana.eu.cc'
        );
    }
    return _canvas;
}

const ASSETS_PATH = path.join(__dirname, 'assets');

/**
 * Remove watermark from an image file
 * @param {string} inputPath - Path to input image
 * @param {string} [outputPath] - Path to save output (optional, defaults to input_clean.png)
 * @param {Object} [options] - Options
 * @param {string} [options.format='png'] - Output format: 'png', 'jpeg', 'webp'
 * @param {number} [options.quality=0.95] - Quality for jpeg/webp (0-1)
 * @param {boolean} [options.silent=false] - Suppress console output
 * @returns {Promise<{outputPath: string, meta: Object}>}
 */
async function removeWatermark(inputPath, outputPath, options = {}) {
    if (!options.silent) printBanner();

    const canvas = getCanvas();
    const fs = require('fs');

    // Validate input
    if (!inputPath) {
        throw new Error('Input image path is required');
    }
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputPath}`);
    }

    // Determine output path
    if (!outputPath) {
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        const dir = path.dirname(inputPath);
        outputPath = path.join(dir, `${base}_clean${ext || '.png'}`);
    }

    // Determine output format
    const format = options.format || path.extname(outputPath).slice(1) || 'png';
    const quality = options.quality || 0.95;

    // Load assets
    const bg48 = await canvas.loadImage(path.join(ASSETS_PATH, 'bg_48.png'));
    const bg96 = await canvas.loadImage(path.join(ASSETS_PATH, 'bg_96.png'));

    // Load input image
    const inputImage = await canvas.loadImage(inputPath);

    // Import core modules dynamically (they use ESM)
    const { calculateAlphaMap } = await import('./core/alphaMap.js');
    const { removeWatermark: removeWM } = await import('./core/blendModes.js');
    const { detectWatermarkConfig, calculateWatermarkPosition, resolveInitialStandardConfig } = await import('./core/watermarkConfig.js');
    const {
        computeRegionSpatialCorrelation,
        computeRegionGradientCorrelation,
        detectAdaptiveWatermarkRegion,
        interpolateAlphaMap,
        warpAlphaMap,
        shouldAttemptAdaptiveFallback
    } = await import('./core/adaptiveDetector.js');

    // Create processing canvas
    const procCanvas = canvas.createCanvas(inputImage.width, inputImage.height);
    const ctx = procCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(inputImage, 0, 0);

    // Get alpha maps from template images
    function getAlphaMapFromBg(bgImage, size) {
        const tmpCanvas = canvas.createCanvas(size, size);
        const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
        tmpCtx.drawImage(bgImage, 0, 0);
        const imgData = tmpCtx.getImageData(0, 0, size, size);
        return calculateAlphaMap(imgData);
    }

    const alpha48 = getAlphaMapFromBg(bg48, 48);
    const alpha96 = getAlphaMapFromBg(bg96, 96);

    // Detect watermark and process
    const originalImageData = ctx.getImageData(0, 0, procCanvas.width, procCanvas.height);
    const defaultConfig = detectWatermarkConfig(procCanvas.width, procCanvas.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData: originalImageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    const config = resolvedConfig;
    const position = calculateWatermarkPosition(procCanvas.width, procCanvas.height, config);
    const alphaMap = config.logoSize === 96 ? alpha96 : alpha48;

    // Clone and process
    const processedData = new ImageData(
        new Uint8ClampedArray(originalImageData.data),
        originalImageData.width,
        originalImageData.height
    );
    removeWM(processedData, alphaMap, position);

    // Write back
    ctx.putImageData(processedData, 0, 0);

    // Save output
    let buffer;
    if (format === 'jpeg' || format === 'jpg') {
        buffer = procCanvas.toBuffer('image/jpeg', { quality });
    } else if (format === 'webp') {
        buffer = procCanvas.toBuffer('image/webp', { quality });
    } else {
        buffer = procCanvas.toBuffer('image/png');
    }

    fs.writeFileSync(outputPath, buffer);

    if (!options.silent) {
        console.log(`✅ Watermark removed: ${outputPath}`);
    }

    return {
        outputPath,
        meta: {
            inputSize: { width: inputImage.width, height: inputImage.height },
            watermark: {
                size: config.logoSize,
                position
            },
            format,
            source: 'standard'
        }
    };
}

/**
 * Remove watermark from a Buffer
 * @param {Buffer} inputBuffer - Image buffer
 * @param {Object} [options] - Options
 * @param {string} [options.format='png'] - Output format
 * @param {number} [options.quality=0.95] - Quality for jpeg/webp
 * @param {boolean} [options.silent=false] - Suppress console output
 * @returns {Promise<{buffer: Buffer, meta: Object}>}
 */
async function removeWatermarkFromBuffer(inputBuffer, options = {}) {
    if (!options.silent) printBanner();

    const canvas = getCanvas();
    const format = options.format || 'png';
    const quality = options.quality || 0.95;

    // Load assets
    const bg48 = await canvas.loadImage(path.join(ASSETS_PATH, 'bg_48.png'));
    const bg96 = await canvas.loadImage(path.join(ASSETS_PATH, 'bg_96.png'));

    // Load input image from buffer
    const inputImage = await canvas.loadImage(inputBuffer);

    // Import core modules
    const { calculateAlphaMap } = await import('./core/alphaMap.js');
    const { removeWatermark: removeWM } = await import('./core/blendModes.js');
    const { detectWatermarkConfig, calculateWatermarkPosition, resolveInitialStandardConfig } = await import('./core/watermarkConfig.js');

    // Create processing canvas
    const procCanvas = canvas.createCanvas(inputImage.width, inputImage.height);
    const ctx = procCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(inputImage, 0, 0);

    // Get alpha maps
    function getAlphaMapFromBg(bgImage, size) {
        const tmpCanvas = canvas.createCanvas(size, size);
        const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
        tmpCtx.drawImage(bgImage, 0, 0);
        const imgData = tmpCtx.getImageData(0, 0, size, size);
        return calculateAlphaMap(imgData);
    }

    const alpha48 = getAlphaMapFromBg(bg48, 48);
    const alpha96 = getAlphaMapFromBg(bg96, 96);

    const originalImageData = ctx.getImageData(0, 0, procCanvas.width, procCanvas.height);
    const defaultConfig = detectWatermarkConfig(procCanvas.width, procCanvas.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData: originalImageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    const config = resolvedConfig;
    const position = calculateWatermarkPosition(procCanvas.width, procCanvas.height, config);
    const alphaMap = config.logoSize === 96 ? alpha96 : alpha48;

    const processedData = new ImageData(
        new Uint8ClampedArray(originalImageData.data),
        originalImageData.width,
        originalImageData.height
    );
    removeWM(processedData, alphaMap, position);
    ctx.putImageData(processedData, 0, 0);

    // Get output buffer
    let buffer;
    if (format === 'jpeg' || format === 'jpg') {
        buffer = procCanvas.toBuffer('image/jpeg', { quality });
    } else if (format === 'webp') {
        buffer = procCanvas.toBuffer('image/webp', { quality });
    } else {
        buffer = procCanvas.toBuffer('image/png');
    }

    return {
        buffer,
        meta: {
            inputSize: { width: inputImage.width, height: inputImage.height },
            watermark: { size: config.logoSize, position },
            format,
            source: 'standard'
        }
    };
}

// Export
module.exports = {
    removeWatermark,
    removeWatermarkFromBuffer,
    version: '1.0.0'
};
