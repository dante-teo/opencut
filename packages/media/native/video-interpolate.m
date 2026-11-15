#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import <VideoToolbox/VTFrameProcessor_LowLatencyFrameInterpolation.h>

static void fail(NSString *message) __attribute__((noreturn));
static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(EXIT_FAILURE);
}

static int64_t integer(const char *text, int64_t minimum, int64_t maximum) {
    char *end;
    errno = 0;
    long long value = strtoll(text, &end, 10);
    if (errno || text == end || *end || value < minimum || value > maximum)
        fail(@"Invalid interpolation worker integer.");
    return value;
}

static double parseDecimal(const char *text, double minimum, double maximum) {
    char *end;
    double value = strtod(text, &end);
    if (text == end || *end || !isfinite(value) || value < minimum || value > maximum)
        fail(@"Invalid interpolation worker number.");
    return value;
}

static CVPixelBufferRef makeBuffer(NSDictionary *attributes, int width, int height)
    CF_RETURNS_RETAINED {
    OSType format = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    NSMutableDictionary *resolved = [attributes mutableCopy];
    resolved[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey] = @(format);
    resolved[(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey] = @{};
    CVPixelBufferRef buffer = NULL;
    OSStatus status = CVPixelBufferCreate(NULL, width, height, format,
        (__bridge CFDictionaryRef)resolved, &buffer);
    if (status || !buffer)
        fail([NSString stringWithFormat:@"Cannot allocate VideoToolbox NV12 buffer (%d).", status]);
    return buffer;
}

static void transfer(FILE *file, CVPixelBufferRef buffer, BOOL write) {
    CVPixelBufferLockFlags flags = write ? kCVPixelBufferLock_ReadOnly : 0;
    if (CVPixelBufferLockBaseAddress(buffer, flags))
        fail(@"Could not lock an interpolation pixel buffer.");
    size_t width = CVPixelBufferGetWidth(buffer);
    for (size_t plane = 0; plane < 2; plane++) {
        uint8_t *base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane);
        size_t stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
        size_t rows = CVPixelBufferGetHeightOfPlane(buffer, plane);
        // Batch tightly packed planes. IOSurface alignment may instead require row I/O.
        size_t chunk = stride == width ? width * rows : width;
        size_t count = stride == width ? 1 : rows;
        for (size_t row = 0; row < count; row++) {
            uint8_t *data = base + row * stride;
            size_t bytes = write ? fwrite(data, 1, chunk, file) : fread(data, 1, chunk, file);
            if (bytes != chunk)
                fail(write ? @"Could not write an interpolated frame." : @"Decoded frame was truncated.");
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, flags);
}

typedef struct {
    int64_t pts;
    double score;
} FrameTiming;

static BOOL readTiming(FILE *metadata, int64_t expected, FrameTiming *timing) {
    char line[256];
    if (!fgets(line, sizeof(line), metadata)) {
        if (ferror(metadata)) fail(@"Cannot read decoded frame timing.");
        return NO;
    }
    long long frame, pts;
    double score;
    if (sscanf(line, "frame:%lld pts:%lld", &frame, &pts) != 2 || frame != expected ||
        !fgets(line, sizeof(line), metadata) ||
        sscanf(line, "lavfi.scd.score=%lf", &score) != 1 || !isfinite(score))
        fail(@"Decoded frame timing or scene scores are missing.");
    *timing = (FrameTiming){pts, score};
    return YES;
}

API_AVAILABLE(macos(26.0))
static VTFrameProcessorFrame *frameAt(CVPixelBufferRef buffer, int64_t pts) {
    VTFrameProcessorFrame *frame = [[VTFrameProcessorFrame alloc] initWithBuffer:buffer
        presentationTimeStamp:CMTimeMake(pts, 1000000)];
    if (!frame) fail(@"VideoToolbox rejected an interpolation frame buffer.");
    return frame;
}

API_AVAILABLE(macos(26.0))
static void interpolate(int width, int height, int depth, int32_t timescale, int64_t step,
                        int64_t duration, double speed, double threshold, NSArray<NSNumber *> *cuts) {
    if (!VTLowLatencyFrameInterpolationConfiguration.isSupported)
        fail(@"VideoToolbox low-latency AI interpolation is unavailable on this Mac. Check opencut system inspect.");
    VTLowLatencyFrameInterpolationConfiguration *config =
        [[VTLowLatencyFrameInterpolationConfiguration alloc] initWithFrameWidth:width frameHeight:height
            numberOfInterpolatedFrames:depth];
    NSNumber *nv12 = @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
    id formats = config.destinationPixelBufferAttributes[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey];
    if (![config.frameSupportedPixelFormats containsObject:nv12] ||
        !([formats isEqual:nv12] || ([formats isKindOfClass:NSArray.class] && [formats containsObject:nv12])))
        fail([NSString stringWithFormat:@"VideoToolbox rejected %dx%d video-range NV12 at this quality. Try a supported size or lower quality.", width, height]);

    NSError *error = nil;
    VTFrameProcessor *processor = [VTFrameProcessor new];
    if (![processor startSessionWithConfiguration:config error:&error])
        fail([NSString stringWithFormat:@"VideoToolbox could not initialize the interpolation model for %dx%d: %@", width, height, error]);

    FILE *metadata = fdopen(3, "r");
    if (!metadata) fail(@"Cannot open decoded frame timing pipe.");
    CVPixelBufferRef previous = makeBuffer(config.sourcePixelBufferAttributes, width, height);
    CVPixelBufferRef next = makeBuffer(config.sourcePixelBufferAttributes, width, height);
    CVPixelBufferRef result = makeBuffer(config.destinationPixelBufferAttributes, width, height);
    FrameTiming first;
    if (!readTiming(metadata, 0, &first)) fail(@"The video stream contains no decoded frames.");
    transfer(stdin, previous, NO);
    int subdivisions = 1 << depth;
    int64_t left = 0, tick = 0, index = 1;
    NSUInteger nextCut = 0;

    FrameTiming timing;
    while (readTiming(metadata, index, &timing)) @autoreleasepool {
        index++;
        transfer(stdin, next, NO);
        int64_t right = timing.pts - first.pts;
        if (right <= left) fail(@"AI interpolation requires strictly increasing decoded video timestamps.");
        BOOL cut = timing.score >= threshold;
        while (nextCut < cuts.count && cuts[nextCut].doubleValue * 1000000 <= right + 0.5) {
            cut = YES;
            nextCut++;
        }
        VTFrameProcessorFrame *a = nil, *b = nil;
        int lastPhase = 0;
        while (tick < duration) {
            double time = (double)tick * speed * 1000000 / timescale;
            // Match original frames despite rounding decoded timestamps to microseconds.
            if (time >= right - 0.5) break;
            CVPixelBufferRef output = previous;
            if (!cut && time > left + 0.5) {
                int phase = (int)lround((time - left) / (right - left) * subdivisions);
                phase = MAX(1, MIN(subdivisions - 1, phase));
                if (phase != lastPhase) {
                    if (!a) {
                        a = frameAt(previous, left);
                        b = frameAt(next, right);
                    }
                    double fraction = (double)phase / subdivisions;
                    VTFrameProcessorFrame *destination = frameAt(result, left + llround((right - left) * fraction));
                    VTLowLatencyFrameInterpolationParameters *params =
                        [[VTLowLatencyFrameInterpolationParameters alloc] initWithSourceFrame:b previousFrame:a
                            interpolationPhase:@[@(fraction)] destinationFrames:@[destination]];
                    if (!params)
                        fail(@"VideoToolbox rejected the selected interpolation phase. Try a lower quality.");
                    if (![processor processWithParameters:params error:&error])
                        fail([NSString stringWithFormat:@"VideoToolbox failed to interpolate near %.6fs: %@", time / 1000000, error]);
                    lastPhase = phase;
                }
                output = result;
            }
            transfer(stdout, output, YES);
            tick += step;
        }
        CVPixelBufferRef swap = previous;
        previous = next;
        next = swap;
        left = right;
    }
    if (index < 2) fail(@"AI interpolation requires at least two decoded frames.");
    if (fgetc(stdin) != EOF || ferror(stdin))
        fail(@"Decoder emitted frames without associated timestamps.");
    if ((double)duration * speed * 1000000 / timescale < left - 1)
        fail(@"Decoded picture extends beyond its declared duration. Remux the input with correct video timing.");
    // No future reference is available for the final source frame.
    for (; tick < duration; tick += step) transfer(stdout, previous, YES);
    if (fflush(stdout)) fail(@"Could not flush interpolated video.");
    fclose(metadata);
    [processor endSession];
    CVPixelBufferRelease(result);
    CVPixelBufferRelease(next);
    CVPixelBufferRelease(previous);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            if (argc != 10) fail(@"Invalid interpolation worker arguments.");
            NSArray *cuts = [NSJSONSerialization JSONObjectWithData:
                [NSData dataWithBytes:argv[9] length:strlen(argv[9])] options:0 error:NULL];
            if (![cuts isKindOfClass:NSArray.class]) fail(@"Invalid interpolation scene boundaries.");
            interpolate((int)integer(argv[1], 2, 16384), (int)integer(argv[2], 2, 16384),
                (int)integer(argv[3], 1, 3), (int32_t)integer(argv[4], 1, 1000000),
                integer(argv[5], 1, 1000000), integer(argv[6], 1, INT64_MAX / 2),
                parseDecimal(argv[7], 0.125, 1), parseDecimal(argv[8], 0, 100), cuts);
        } else {
            fail(@"VideoToolbox low-latency AI interpolation requires macOS 26 or later.");
        }
    }
    return EXIT_SUCCESS;
}
