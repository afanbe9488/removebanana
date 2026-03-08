/**
 * RemoveBanana — Remove AI watermarks from Gemini images
 * 🍌 https://removebanana.eu.cc
 */

export interface WatermarkMeta {
    inputSize: { width: number; height: number };
    watermark: {
        size: number;
        position: { x: number; y: number; width: number; height: number };
    };
    format: string;
    source: string;
}

export interface RemoveWatermarkResult {
    outputPath: string;
    meta: WatermarkMeta;
}

export interface RemoveWatermarkBufferResult {
    buffer: Buffer;
    meta: WatermarkMeta;
}

export interface RemoveWatermarkOptions {
    format?: 'png' | 'jpeg' | 'jpg' | 'webp';
    quality?: number;
    silent?: boolean;
}

/**
 * Remove watermark from an image file
 */
export function removeWatermark(
    inputPath: string,
    outputPath?: string,
    options?: RemoveWatermarkOptions
): Promise<RemoveWatermarkResult>;

/**
 * Remove watermark from an image Buffer
 */
export function removeWatermarkFromBuffer(
    inputBuffer: Buffer,
    options?: RemoveWatermarkOptions
): Promise<RemoveWatermarkBufferResult>;

export const version: string;
