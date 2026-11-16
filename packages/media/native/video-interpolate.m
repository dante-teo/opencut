#include "pixel-transfer.h"
#include <stdio.h>
#include <string.h>
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

static CVPixelBufferRef makeBuffer(NSDictionary *attributes, int width, int height, OSType format)
    CF_RETURNS_RETAINED {
    NSMutableDictionary *resolved = [attributes mutableCopy];
    resolved[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey] = @(format);
    resolved[(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey] = @{};
    CVPixelBufferRef buffer = NULL;
    OSStatus status = CVPixelBufferCreate(NULL, width, height, format,
        (__bridge CFDictionaryRef)resolved, &buffer);
    if (status || !buffer)
        fail([NSString stringWithFormat:@"Cannot allocate VideoToolbox interpolation buffer (%d).", status]);
    return buffer;
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

API_AVAILABLE(macos(15.4))
static VTFrameProcessorFrame *frameAt(CVPixelBufferRef buffer, int64_t pts) {
    VTFrameProcessorFrame *frame = [[VTFrameProcessorFrame alloc] initWithBuffer:buffer
        presentationTimeStamp:CMTimeMake(pts, 1000000)];
    if (!frame) fail(@"VideoToolbox rejected an interpolation frame buffer.");
    return frame;
}

API_AVAILABLE(macos(15.4))
static id<VTFrameProcessorConfiguration> configuration(int width, int height, BOOL offline, OSType format) {
    id<VTFrameProcessorConfiguration> config = nil;
    if (offline) {
        BOOL supported;
        if (@available(macOS 26.0, *)) {
            supported = VTFrameRateConversionConfiguration.isSupported;
        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            supported = VTFrameRateConversionConfiguration.processorSupported;
#pragma clang diagnostic pop
        }
        if (!supported)
            fail(@"VideoToolbox offline interpolation is unavailable. Run opencut system inspect --json or select fast explicitly on macOS 26+.");
        config = [[VTFrameRateConversionConfiguration alloc] initWithFrameWidth:width frameHeight:height
            usePrecomputedFlow:NO qualityPrioritization:VTFrameRateConversionConfigurationQualityPrioritizationQuality
            revision:VTFrameRateConversionConfigurationRevision1];
    } else if (@available(macOS 26.0, *)) {
        if (VTLowLatencyFrameInterpolationConfiguration.isSupported)
            config = [[VTLowLatencyFrameInterpolationConfiguration alloc] initWithFrameWidth:width frameHeight:height
                numberOfInterpolatedFrames:1];
    }
    id formats = config.destinationPixelBufferAttributes[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey];
    if (![config.frameSupportedPixelFormats containsObject:@(format)] ||
        !([formats isEqual:@(format)] || ([formats isKindOfClass:NSArray.class] && [formats containsObject:@(format)])))
        fail([NSString stringWithFormat:@"VideoToolbox %@ interpolation does not support %dx%d on this system. Run opencut system inspect --json.", offline ? @"offline" : @"low-latency", width, height]);
    return config;
}

API_AVAILABLE(macos(15.4))
static void interpolate(int width, int height, BOOL offline, int32_t timescale, int64_t step,
                        int64_t duration, double speed, double threshold, NSArray<NSNumber *> *cuts) {
    OSType format = offline ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    id<VTFrameProcessorConfiguration> config = configuration(width, height, offline, format);

    NSError *error = nil;
    VTFrameProcessor *processor = [VTFrameProcessor new];
    if (![processor startSessionWithConfiguration:config error:&error])
        fail([NSString stringWithFormat:@"VideoToolbox could not initialize the interpolation model for %dx%d: %@", width, height, error]);

    FILE *metadata = fdopen(3, "r");
    if (!metadata) fail(@"Cannot open decoded frame timing pipe.");
    CVPixelBufferRef previous = makeBuffer(config.sourcePixelBufferAttributes, width, height, format);
    CVPixelBufferRef next = makeBuffer(config.sourcePixelBufferAttributes, width, height, format);
    CVPixelBufferRef result = makeBuffer(config.destinationPixelBufferAttributes, width, height, format);
    uint8_t *scratch = allocatePixelTransferScratch(format, width);
    FrameTiming first;
    if (!readTiming(metadata, 0, &first)) fail(@"The video stream contains no decoded frames.");
    transferPixels(stdin, previous, ReadPixels, scratch);
    int64_t left = 0, tick = 0, index = 1;
    NSUInteger nextCut = 0;
    int64_t lastReference = -1;

    FrameTiming timing;
    while (readTiming(metadata, index, &timing)) @autoreleasepool {
        index++;
        transferPixels(stdin, next, ReadPixels, scratch);
        int64_t right = timing.pts - first.pts;
        if (right <= left) fail(@"AI interpolation requires strictly increasing decoded video timestamps.");
        BOOL cut = timing.score >= threshold;
        while (nextCut < cuts.count && cuts[nextCut].doubleValue * 1000000 <= right + 0.5) {
            cut = YES;
            nextCut++;
        }
        VTFrameProcessorFrame *a = nil, *b = nil;
        if (cut) lastReference = -1;
        while (tick < duration) {
            double time = (double)tick * speed * 1000000 / timescale;
            // Match original frames despite rounding decoded timestamps to microseconds.
            if (time >= right - 0.5) break;
            CVPixelBufferRef output = previous;
            if (!cut && time > left + 0.5) {
                if (offline || !a) {
                    double fraction = offline ? (time - left) / (right - left) : 0.5;
                    BOOL repeated = a != nil;
                    if (!a) {
                        a = frameAt(previous, left);
                        b = frameAt(next, right);
                    }
                    VTFrameProcessorFrame *destination = frameAt(result, left + llround((right - left) * fraction));
                    id<VTFrameProcessorParameters> params = nil;
                    if (offline) {
                        VTFrameRateConversionParametersSubmissionMode mode = repeated ?
                            VTFrameRateConversionParametersSubmissionModeSequentialReferencesUnchanged :
                            lastReference == left ? VTFrameRateConversionParametersSubmissionModeSequential :
                            VTFrameRateConversionParametersSubmissionModeRandom;
                        params = [[VTFrameRateConversionParameters alloc] initWithSourceFrame:a nextFrame:b
                            opticalFlow:nil interpolationPhase:@[@(fraction)] submissionMode:mode
                            destinationFrames:@[destination]];
                        lastReference = right;
                    } else if (@available(macOS 26.0, *)) {
                        params = [[VTLowLatencyFrameInterpolationParameters alloc] initWithSourceFrame:b previousFrame:a
                            interpolationPhase:@[@(fraction)] destinationFrames:@[destination]];
                    }
                    if (!params)
                        fail(@"VideoToolbox rejected the interpolation phase. Check the source timestamps and target rate.");
                    if (![processor processWithParameters:params error:&error])
                        fail([NSString stringWithFormat:@"VideoToolbox failed to interpolate near %.6fs: %@", time / 1000000, error]);
                }
                output = result;
            }
            transferPixels(stdout, output, WritePixels, scratch);
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
    for (; tick < duration; tick += step) transferPixels(stdout, previous, WritePixels, scratch);
    if (fflush(stdout)) fail(@"Could not flush interpolated video.");
    fclose(metadata);
    free(scratch);
    [processor endSession];
    CVPixelBufferRelease(result);
    CVPixelBufferRelease(next);
    CVPixelBufferRelease(previous);
}

int main(int argc, const char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(OPENCUT_VERSION);
        return 0;
    }
    @autoreleasepool {
        if (@available(macOS 15.4, *)) {
            if (argc != 10) fail(@"Invalid interpolation worker arguments.");
            NSArray *cuts = [NSJSONSerialization JSONObjectWithData:
                [NSData dataWithBytes:argv[9] length:strlen(argv[9])] options:0 error:NULL];
            if (![cuts isKindOfClass:NSArray.class]) fail(@"Invalid interpolation scene boundaries.");
            interpolate((int)integer(argv[1], 2, 16384), (int)integer(argv[2], 2, 16384),
                (BOOL)integer(argv[3], 0, 1), (int32_t)integer(argv[4], 1, 1000000),
                integer(argv[5], 1, 1000000), integer(argv[6], 1, INT64_MAX / 2),
                parseDecimal(argv[7], 0.125, 1), parseDecimal(argv[8], 0, 100), cuts);
        } else {
            fail(@"VideoToolbox offline interpolation requires macOS 15.4 or later. Fast requires macOS 26 or later.");
        }
    }
    return EXIT_SUCCESS;
}
