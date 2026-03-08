/**
 * RemoveBanana — Watermark Engine (Browser + Node.js)
 * Coordinates watermark detection, alpha map calculation, and removal operations
 * 
 * 🍌 Powered by RemoveBanana — https://removebanana.eu.cc
 */

import { calculateAlphaMap } from './alphaMap.js';
import { removeWatermark } from './blendModes.js';
import {
    computeRegionSpatialCorrelation,
    computeRegionGradientCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    warpAlphaMap,
    shouldAttemptAdaptiveFallback
} from './adaptiveDetector.js';
import {
    detectWatermarkConfig,
    calculateWatermarkPosition,
    resolveInitialStandardConfig
} from './watermarkConfig.js';

export { detectWatermarkConfig, calculateWatermarkPosition } from './watermarkConfig.js';

const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const TEMPLATE_ALIGN_SHIFTS = [-0.5, -0.25, 0, 0.25, 0.5];
const TEMPLATE_ALIGN_SCALES = [0.99, 1, 1.01];
const SUBPIXEL_REFINE_SHIFTS = [-0.25, 0, 0.25];
const SUBPIXEL_REFINE_SCALES = [0.99, 1, 1.01];
const ALPHA_GAIN_CANDIDATES = [1.05, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.7, 1.85, 2.0, 2.2, 2.4, 2.6];

// --- Runtime Detection ---
let _nodeCanvas = null;
function getNodeCanvas() {
    if (_nodeCanvas === null) {
        try {
            _nodeCanvas = await import('canvas').catch(() => null) || false;
        } catch {
            _nodeCanvas = false;
        }
    }
    return _nodeCanvas || null;
}

let _nodeCanvasModule = undefined;
function tryRequireCanvas() {
    if (_nodeCanvasModule !== undefined) return _nodeCanvasModule;
    try {
        // Dynamic require for Node.js canvas
        const mod = typeof require !== 'undefined' ? require('canvas') : null;
        _nodeCanvasModule = mod;
    } catch {
        _nodeCanvasModule = null;
    }
    return _nodeCanvasModule;
}

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

function createRuntimeCanvas(width, height) {
    // Try OffscreenCanvas first (modern browsers + some Node runtimes)
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }

    // Try browser DOM canvas
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    // Try node-canvas
    if (isNode) {
        const nodeCanvas = tryRequireCanvas();
        if (nodeCanvas) {
            return nodeCanvas.createCanvas(width, height);
        }
    }

    throw new Error(
        'Canvas runtime not available. ' +
        'In Node.js, install node-canvas: npm install canvas. ' +
        'See https://removebanana.eu.cc for browser-based usage.'
    );
}

function getCanvasContext2D(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Failed to get 2D canvas context');
    }
    return ctx;
}

async function loadBackgroundCapture(source) {
    // Browser: use Image element
    if (typeof Image !== 'undefined' && !isNode) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const timer = setTimeout(() => {
                reject(new Error(`Timeout loading background capture: ${source}`));
            }, 5000);

            image.onload = () => {
                clearTimeout(timer);
                resolve(image);
            };
            image.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`Failed to load background capture: ${source}`));
            };
            image.src = source;
        });
    }

    // Node.js: use node-canvas loadImage
    if (isNode) {
        const nodeCanvas = tryRequireCanvas();
        if (nodeCanvas && nodeCanvas.loadImage) {
            return await nodeCanvas.loadImage(source);
        }
    }

    // Fallback: createImageBitmap
    if (typeof createImageBitmap !== 'undefined' && typeof fetch !== 'undefined') {
        const response = await fetch(source);
        if (!response.ok) {
            throw new Error(`Failed to load background capture: ${response.status}`);
        }
        const blob = await response.blob();
        return await createImageBitmap(blob);
    }

    throw new Error('No image loader available in current runtime');
}

function cloneImageData(imageData) {
    return new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width,
        imageData.height
    );
}

function shouldRecalibrateAlphaStrength({ originalScore, processedScore, suppressionGain }) {
    return originalScore >= 0.6 &&
        processedScore >= RESIDUAL_RECALIBRATION_THRESHOLD &&
        suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
}

function calculateNearBlackRatio(imageData, position) {
    let nearBlack = 0;
    let total = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r <= NEAR_BLACK_THRESHOLD && g <= NEAR_BLACK_THRESHOLD && b <= NEAR_BLACK_THRESHOLD) {
                nearBlack++;
            }
            total++;
        }
    }

    return total > 0 ? nearBlack / total : 0;
}

function findBestTemplateWarp({
    originalImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore
}) {
    const size = position.width;
    if (!size || size <= 8) return null;

    let best = {
        spatialScore: baselineSpatialScore,
        gradientScore: baselineGradientScore,
        shift: { dx: 0, dy: 0, scale: 1 },
        alphaMap
    };

    for (const scale of TEMPLATE_ALIGN_SCALES) {
        for (const dy of TEMPLATE_ALIGN_SHIFTS) {
            for (const dx of TEMPLATE_ALIGN_SHIFTS) {
                if (dx === 0 && dy === 0 && scale === 1) continue;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                const spatialScore = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });
                const gradientScore = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });

                const confidence =
                    Math.max(0, spatialScore) * 0.7 +
                    Math.max(0, gradientScore) * 0.3;
                const bestConfidence =
                    Math.max(0, best.spatialScore) * 0.7 +
                    Math.max(0, best.gradientScore) * 0.3;

                if (confidence > bestConfidence + 0.01) {
                    best = {
                        spatialScore,
                        gradientScore,
                        shift: { dx, dy, scale },
                        alphaMap: warped
                    };
                }
            }
        }
    }

    const improvedSpatial = best.spatialScore >= baselineSpatialScore + 0.01;
    const improvedGradient = best.gradientScore >= baselineGradientScore + 0.01;
    return improvedSpatial || improvedGradient ? best : null;
}

function refineSubpixelOutline({
    originalImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore,
    baselineShift
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < OUTLINE_REFINEMENT_MIN_GAIN) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.01).toFixed(2)));
    const upper = Number((alphaGain + 0.01).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    const baseDx = baselineShift?.dx ?? 0;
    const baseDy = baselineShift?.dy ?? 0;
    const baseScale = baselineShift?.scale ?? 1;

    let best = null;
    for (const scaleDelta of SUBPIXEL_REFINE_SCALES) {
        const scale = Number((baseScale * scaleDelta).toFixed(4));
        for (const dyDelta of SUBPIXEL_REFINE_SHIFTS) {
            const dy = baseDy + dyDelta;
            for (const dxDelta of SUBPIXEL_REFINE_SHIFTS) {
                const dx = baseDx + dxDelta;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(originalImageData);
                    removeWatermark(candidate, warped, position, { alphaGain: gain });
                    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
                    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });

                    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap: warped,
                            alphaGain: gain,
                            shift: { dx, dy, scale },
                            spatialScore,
                            gradientScore,
                            nearBlackRatio,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - 0.04;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + 0.08;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function recalibrateAlphaStrength({
    originalImageData,
    alphaMap,
    position,
    originalSpatialScore,
    processedSpatialScore,
    originalNearBlackRatio
}) {
    let bestScore = processedSpatialScore;
    let bestGain = 1;
    let bestImageData = null;
    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const refinedCandidates = [];
    for (let delta = -0.05; delta <= 0.05; delta += 0.01) {
        refinedCandidates.push(Number((bestGain + delta).toFixed(2)));
    }

    for (const alphaGain of refinedCandidates) {
        if (alphaGain <= 1 || alphaGain >= 3) continue;
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const scoreDelta = processedSpatialScore - bestScore;
    if (!bestImageData || scoreDelta < MIN_RECALIBRATION_SCORE_DELTA) {
        return null;
    }

    return {
        imageData: bestImageData,
        alphaGain: bestGain,
        processedSpatialScore: bestScore,
        suppressionGain: originalSpatialScore - bestScore
    };
}

/**
 * Watermark engine class
 * Coordinates watermark detection, alpha map calculation, and removal operations
 * 
 * 🍌 https://removebanana.eu.cc
 */
export class WatermarkEngine {
    constructor(bgCaptures) {
        this.bgCaptures = bgCaptures;
        this.alphaMaps = {};
    }

    /**
     * Create engine — loads bg_48.png and bg_96.png
     * @param {Object} [options] - Options
     * @param {string} [options.assetsPath] - Custom path to assets directory
     */
    static async create(options = {}) {
        const assetsPath = options.assetsPath || WatermarkEngine._resolveAssetsPath();

        const bg48Path = assetsPath + '/bg_48.png';
        const bg96Path = assetsPath + '/bg_96.png';

        const bg48 = await loadBackgroundCapture(bg48Path);
        const bg96 = await loadBackgroundCapture(bg96Path);

        return new WatermarkEngine({ bg48, bg96 });
    }

    /**
     * Resolve assets path based on runtime
     */
    static _resolveAssetsPath() {
        if (isNode) {
            // Node.js: resolve relative to this file
            const path = typeof require !== 'undefined' ? require('path') : null;
            if (path) {
                return path.join(__dirname, '..', 'assets');
            }
        }
        // Browser: assume /assets/ is served at root
        return '/assets';
    }

    /**
     * Get alpha map from background captured image based on watermark size
     * @param {number} size - Watermark size (48 or 96)
     * @returns {Promise<Float32Array>} Alpha map
     */
    async getAlphaMap(size) {
        if (size !== 48 && size !== 96) {
            if (this.alphaMaps[size]) return this.alphaMaps[size];
            const alpha96 = await this.getAlphaMap(96);
            const interpolated = interpolateAlphaMap(alpha96, 96, size);
            this.alphaMaps[size] = interpolated;
            return interpolated;
        }

        if (this.alphaMaps[size]) {
            return this.alphaMaps[size];
        }

        const bgImage = size === 48 ? this.bgCaptures.bg48 : this.bgCaptures.bg96;
        const canvas = createRuntimeCanvas(size, size);
        const ctx = getCanvasContext2D(canvas);
        ctx.drawImage(bgImage, 0, 0);

        const imageData = ctx.getImageData(0, 0, size, size);
        const alphaMap = calculateAlphaMap(imageData);
        this.alphaMaps[size] = alphaMap;

        return alphaMap;
    }

    /**
     * Remove watermark from image
     * @param {HTMLImageElement|HTMLCanvasElement|Image} image - Input image
     * @param {Object} [options] - Options { adaptiveMode: 'auto'|'always'|'never' }
     * @returns {Promise<HTMLCanvasElement>} Processed canvas
     */
    async removeWatermarkFromImage(image, options = {}) {
        const adaptiveMode = options.adaptiveMode || 'auto';

        const canvas = createRuntimeCanvas(image.width, image.height);
        const ctx = getCanvasContext2D(canvas);
        ctx.drawImage(image, 0, 0);

        const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const defaultConfig = detectWatermarkConfig(canvas.width, canvas.height);
        const alpha48 = await this.getAlphaMap(48);
        const alpha96 = await this.getAlphaMap(96);
        const resolvedConfig = resolveInitialStandardConfig({
            imageData: originalImageData,
            defaultConfig,
            alpha48,
            alpha96
        });

        let config = resolvedConfig;
        let position = calculateWatermarkPosition(canvas.width, canvas.height, config);
        let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;
        let source = 'standard';
        let adaptiveConfidence = null;
        let alphaGain = 1;

        const fixedImageData = cloneImageData(originalImageData);
        removeWatermark(fixedImageData, alphaMap, position);

        let finalImageData = fixedImageData;
        const shouldFallback = adaptiveMode === 'always'
            ? true
            : shouldAttemptAdaptiveFallback({
                processedImageData: fixedImageData,
                alphaMap,
                position,
                originalImageData,
                originalSpatialMismatchThreshold: 0
            });

        if (shouldFallback) {
            const adaptive = detectAdaptiveWatermarkRegion({
                imageData: originalImageData,
                alpha96,
                defaultConfig: config
            });

            if (adaptive.found) {
                adaptiveConfidence = adaptive.confidence;
                const size = adaptive.region.size;
                const adaptivePosition = {
                    x: adaptive.region.x,
                    y: adaptive.region.y,
                    width: size,
                    height: size
                };
                const positionDelta =
                    Math.abs(adaptivePosition.x - position.x) +
                    Math.abs(adaptivePosition.y - position.y) +
                    Math.abs(adaptivePosition.width - position.width);

                if (positionDelta >= 4) {
                    position = adaptivePosition;
                    alphaMap = await this.getAlphaMap(size);
                    config = {
                        logoSize: size,
                        marginRight: canvas.width - adaptivePosition.x - size,
                        marginBottom: canvas.height - adaptivePosition.y - size
                    };
                    source = 'adaptive';
                    const adaptiveImageData = cloneImageData(originalImageData);
                    removeWatermark(adaptiveImageData, alphaMap, position);
                    finalImageData = adaptiveImageData;
                }
            }
        }

        let originalSpatialScore = computeRegionSpatialCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        let originalGradientScore = computeRegionGradientCorrelation({
            imageData: originalImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });

        const templateWarp = findBestTemplateWarp({
            originalImageData,
            alphaMap,
            position,
            baselineSpatialScore: originalSpatialScore,
            baselineGradientScore: originalGradientScore
        });
        if (templateWarp) {
            alphaMap = templateWarp.alphaMap;
            originalSpatialScore = templateWarp.spatialScore;
            originalGradientScore = templateWarp.gradientScore;
        }

        const processedSpatialScore = computeRegionSpatialCorrelation({
            imageData: finalImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        const processedGradientScore = computeRegionGradientCorrelation({
            imageData: finalImageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        });
        let finalProcessedSpatialScore = processedSpatialScore;
        let finalProcessedGradientScore = processedGradientScore;
        let suppressionGain = originalSpatialScore - finalProcessedSpatialScore;

        if (shouldRecalibrateAlphaStrength({
            originalScore: originalSpatialScore,
            processedScore: finalProcessedSpatialScore,
            suppressionGain
        })) {
            const originalNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
            const recalibrated = recalibrateAlphaStrength({
                originalImageData,
                alphaMap,
                position,
                originalSpatialScore,
                processedSpatialScore: finalProcessedSpatialScore,
                originalNearBlackRatio
            });

            if (recalibrated) {
                finalImageData = recalibrated.imageData;
                alphaGain = recalibrated.alphaGain;
                finalProcessedSpatialScore = recalibrated.processedSpatialScore;
                suppressionGain = recalibrated.suppressionGain;
                source = source === 'adaptive' ? 'adaptive+gain' : 'standard+gain';
            }
        }

        if (finalProcessedSpatialScore <= 0.3 && finalProcessedGradientScore >= OUTLINE_REFINEMENT_THRESHOLD) {
            const originalNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
            const baselineShift = templateWarp?.shift ?? { dx: 0, dy: 0, scale: 1 };
            const refined = refineSubpixelOutline({
                originalImageData,
                alphaMap,
                position,
                alphaGain,
                originalNearBlackRatio,
                baselineSpatialScore: finalProcessedSpatialScore,
                baselineGradientScore: finalProcessedGradientScore,
                baselineShift
            });

            if (refined) {
                finalImageData = refined.imageData;
                alphaMap = refined.alphaMap;
                alphaGain = refined.alphaGain;
                finalProcessedSpatialScore = refined.spatialScore;
                finalProcessedGradientScore = refined.gradientScore;
                suppressionGain = originalSpatialScore - finalProcessedSpatialScore;
                source = `${source}+subpixel`;
            }
        }

        ctx.putImageData(finalImageData, 0, 0);

        canvas.__watermarkMeta = {
            size: position.width,
            position,
            config: {
                logoSize: config.logoSize,
                marginRight: config.marginRight,
                marginBottom: config.marginBottom
            },
            detection: {
                adaptiveConfidence,
                originalSpatialScore,
                originalGradientScore,
                processedSpatialScore: finalProcessedSpatialScore,
                processedGradientScore: finalProcessedGradientScore,
                suppressionGain
            },
            templateWarp: templateWarp?.shift ?? null,
            alphaGain,
            source
        };

        return canvas;
    }

    /**
     * Get watermark information (for display)
     * @param {number} imageWidth
     * @param {number} imageHeight
     * @returns {Object} Watermark information
     */
    getWatermarkInfo(imageWidth, imageHeight) {
        const config = detectWatermarkConfig(imageWidth, imageHeight);
        const position = calculateWatermarkPosition(imageWidth, imageHeight, config);

        return { size: config.logoSize, position, config };
    }
}
