/**
 * Alpha Map calculator
 * Calculate alpha map from captured background image
 * Alpha channel map module
 */

/**
 * Calculate alpha map from background captured image
 * @param {ImageData} bgCaptureImageData - ImageData object for background capture
 * @returns {Float32Array} Alpha map (value range 0.0-1.0)
 */
export function calculateAlphaMap(bgCaptureImageData) {
    const { width, height, data } = bgCaptureImageData;
    const alphaMap = new Float32Array(width * height);

    // For each pixel, take the maximum value of the three RGB channels and normalize to [0, 1]
    for (let i = 0; i < alphaMap.length; i++) {
        const idx = i * 4; // RGBA format, 4 bytes per pixel
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Take the maximum value of the three RGB channels as the brightness value
        const maxChannel = Math.max(r, g, b);

        // Normalize to [0, 1] range
        alphaMap[i] = maxChannel / 255.0;
    }

    return alphaMap;
}
