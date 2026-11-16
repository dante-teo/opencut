// Exercise the shared pixel pipe without loading a VideoToolbox model.
#include "../../packages/media/native/pixel-transfer.h"
#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#import <Foundation/Foundation.h>

int main(void) {
    @autoreleasepool {
        // Cover every half-float bit pattern, a partial strip and row padding.
        const size_t width = 257, height = 65, components = width * height * 4;
        const OSType format = kCVPixelFormatType_64RGBAHalf;
        NSDictionary *attributes = @{ (__bridge NSString *)kCVPixelBufferBytesPerRowAlignmentKey: @256 };
        CVPixelBufferRef buffer = NULL;
        assert(CVPixelBufferCreate(NULL, width, height, format, (__bridge CFDictionaryRef)attributes, &buffer) == 0);
        uint8_t *scratch = allocatePixelTransferScratch(format, width);
        uint8_t *actual = malloc(components);
        assert(actual);
        assert(CVPixelBufferLockBaseAddress(buffer, 0) == 0);
        size_t stride = CVPixelBufferGetBytesPerRow(buffer);
        assert(stride > width * 4 * sizeof(_Float16));
        uint8_t *base = CVPixelBufferGetBaseAddress(buffer);
        for (size_t y = 0; y < height; y++) {
            for (size_t x = 0; x < width * 4; x++) {
                uint16_t bits = (uint16_t)(y * width * 4 + x);
                memcpy(base + y * stride + x * 2, &bits, 2);
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        FILE *file = tmpfile();
        assert(file);
        transferPixels(file, buffer, WritePixels, scratch);
        rewind(file);
        assert(fread(actual, 1, components, file) == components);
        assert(fgetc(file) == EOF && !ferror(file));
        assert(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == 0);
        base = CVPixelBufferGetBaseAddress(buffer);
        for (size_t y = 0; y < height; y++) {
            _Float16 *row = (_Float16 *)(base + y * stride);
            for (size_t x = 0; x < width * 4; x++) {
                uint8_t expected = (uint8_t)lrintf(fminf(1, fmaxf(0, row[x])) * 255);
                // vImage defines every NaN as black; finite values must match exactly.
                assert(actual[y * width * 4 + x] == (isnan(row[x]) ? 0 : expected));
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
        rewind(file);
        transferPixels(file, buffer, ReadPixels, scratch);
        assert(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == 0);
        base = CVPixelBufferGetBaseAddress(buffer);
        for (size_t y = 0; y < height; y++) {
            _Float16 *row = (_Float16 *)(base + y * stride);
            for (size_t x = 0; x < width * 4; x++)
                assert(row[x] == (_Float16)(actual[y * width * 4 + x] / 255.0f));
        }
        CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
        fclose(file);
        CVPixelBufferRelease(buffer);
        free(actual);
        free(scratch);
    }
}
