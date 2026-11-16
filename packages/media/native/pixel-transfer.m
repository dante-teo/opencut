#include "pixel-transfer.h"
#include <stdlib.h>
#import <Accelerate/Accelerate.h>

enum { StripRows = 64, RGBAComponents = 4 };

static _Noreturn void pixelTransferFailed(const char *message) {
    fprintf(stderr, "%s\n", message);
    exit(EXIT_FAILURE);
}

uint8_t *allocatePixelTransferScratch(OSType format, size_t width) {
    if (format != kCVPixelFormatType_64RGBAHalf) return NULL;
    uint8_t *scratch = malloc(width * RGBAComponents * StripRows);
    if (!scratch) pixelTransferFailed("Could not allocate RGBA pixel transfer scratch.");
    return scratch;
}

static void transferBytes(FILE *file, void *data, size_t length, PixelTransferDirection direction) {
    size_t count = direction == WritePixels ? fwrite(data, 1, length, file) : fread(data, 1, length, file);
    if (count != length)
        pixelTransferFailed(direction == WritePixels ? "Could not write processed frame pixels." :
            "Decoded frame pixels were truncated.");
}

static void transferNV12(FILE *file, CVPixelBufferRef buffer, PixelTransferDirection direction) {
    size_t width = CVPixelBufferGetWidth(buffer);
    for (size_t plane = 0; plane < CVPixelBufferGetPlaneCount(buffer); plane++) {
        uint8_t *base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane);
        size_t stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
        size_t height = CVPixelBufferGetHeightOfPlane(buffer, plane);
        // Both NV12 planes have width bytes per row, excluding alignment padding.
        if (stride == width) transferBytes(file, base, width * height, direction);
        else for (size_t y = 0; y < height; y++)
            transferBytes(file, base + y * stride, width, direction);
    }
}

static void transferRGBA(FILE *file, CVPixelBufferRef buffer, PixelTransferDirection direction, uint8_t *scratch) {
    uint8_t *base = CVPixelBufferGetBaseAddress(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    size_t height = CVPixelBufferGetHeight(buffer);
    size_t components = CVPixelBufferGetWidth(buffer) * RGBAComponents;
    for (size_t y = 0; y < height; y += StripRows) {
        size_t rows = height - y < StripRows ? height - y : StripRows;
        // Treat the interleaved channels as one row of scalar samples.
        vImage_Buffer half = { base + y * stride, rows, components, stride };
        vImage_Buffer bytes = { scratch, rows, components, components };
        size_t length = components * rows;
        if (direction == WritePixels) {
            if (vImageConvert_Planar16FtoPlanar8(&half, &bytes, kvImageNoFlags))
                pixelTransferFailed("Could not convert processed pixels to RGBA8.");
            transferBytes(file, scratch, length, direction);
        } else {
            transferBytes(file, scratch, length, direction);
            if (vImageConvert_Planar8toPlanar16F(&bytes, &half, kvImageNoFlags))
                pixelTransferFailed("Could not convert decoded pixels to RGBA half-float.");
        }
    }
}

void transferPixels(FILE *file, CVPixelBufferRef buffer, PixelTransferDirection direction, uint8_t *scratch) {
    CVPixelBufferLockFlags flags = direction == WritePixels ? kCVPixelBufferLock_ReadOnly : 0;
    if (CVPixelBufferLockBaseAddress(buffer, flags))
        pixelTransferFailed("Could not lock a pixel buffer for transfer.");
    switch (CVPixelBufferGetPixelFormatType(buffer)) {
        case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
            transferNV12(file, buffer, direction);
            break;
        case kCVPixelFormatType_64RGBAHalf:
            transferRGBA(file, buffer, direction, scratch);
            break;
        default:
            pixelTransferFailed("Unsupported pixel buffer format for transfer.");
    }
    CVPixelBufferUnlockBaseAddress(buffer, flags);
}
