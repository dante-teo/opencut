#pragma once
#include <stdio.h>
#include <CoreVideo/CoreVideo.h>

typedef enum { ReadPixels, WritePixels } PixelTransferDirection;

// Allocate scratch for the widest surface transferred by this worker.
// NV12 transfers directly and does not need scratch.
uint8_t *allocatePixelTransferScratch(OSType format, size_t width);
void transferPixels(FILE *file, CVPixelBufferRef buffer, PixelTransferDirection direction, uint8_t *scratch);
