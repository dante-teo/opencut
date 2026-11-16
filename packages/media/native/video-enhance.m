#include <stdio.h>
#include <string.h>
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import <VideoToolbox/VTFrameProcessor_LowLatencySuperResolutionScaler.h>
#import <VideoToolbox/VTFrameProcessor_TemporalNoiseFilter.h>

static void fail(NSString *message) __attribute__((noreturn));
static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(EXIT_FAILURE);
}

static const OSType NV12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
static const OSType RGBAHalf = kCVPixelFormatType_64RGBAHalf;

typedef NS_ENUM(int, Mode) { Fast, Video, Noise };

typedef struct {
    int width, height, clock, frameTicks, frameBudget;
    int64_t count;
    double scale, rounding, strength;
    Mode mode;
} Options;

static int64_t integer(const char *text, int64_t maximum) {
    char *end;
    errno = 0;
    long long value = strtoll(text, &end, 10);
    if (errno || end == text || *end || value < 1 || value > maximum)
        fail(@"Invalid enhancement worker integer.");
    return value;
}

static double number(const char *text, double minimum, double maximum) {
    char *end;
    double value = strtod(text, &end);
    if (end == text || *end || !isfinite(value) || value < minimum || value > maximum)
        fail(@"Invalid enhancement worker number.");
    return value;
}

API_AVAILABLE(macos(26.0))
static id<VTFrameProcessorConfiguration> configuration(Options options) {
    int width = options.width, height = options.height;
    switch (options.mode) {
        case Fast:
            if (!VTLowLatencySuperResolutionScalerConfiguration.isSupported)
                fail(@"VideoToolbox low-latency super-resolution is unsupported on this Mac. Check opencut system inspect.");
            if (![[VTLowLatencySuperResolutionScalerConfiguration supportedScaleFactorsForFrameWidth:width
                frameHeight:height] containsObject:@(options.scale)])
                fail([NSString stringWithFormat:@"VideoToolbox does not support %dx%d at %.1f× in the fast preset. Run opencut system inspect --json or explicitly select the quality profile.", width, height, options.scale]);
            return [[VTLowLatencySuperResolutionScalerConfiguration alloc]
                initWithFrameWidth:width frameHeight:height scaleFactor:options.scale];
        case Video: {
            if (!VTSuperResolutionScalerConfiguration.isSupported)
                fail(@"VideoToolbox video super-resolution is unsupported on this Mac. Check opencut system inspect.");
            VTSuperResolutionScalerConfiguration *config = [[VTSuperResolutionScalerConfiguration alloc]
                initWithFrameWidth:width frameHeight:height scaleFactor:(NSInteger)options.scale
                inputType:VTSuperResolutionScalerConfigurationInputTypeVideo usePrecomputedFlow:NO
                qualityPrioritization:VTSuperResolutionScalerConfigurationQualityPrioritizationNormal
                revision:VTSuperResolutionScalerConfigurationRevision1];
            if (config) {
                switch (config.configurationModelStatus) {
                    case VTSuperResolutionScalerConfigurationModelStatusDownloadRequired:
                        fail(@"The Apple video super-resolution model requires a download. Check model availability with opencut system inspect.");
                    case VTSuperResolutionScalerConfigurationModelStatusDownloading:
                        fail(@"The Apple video super-resolution model is still downloading. Retry when it is ready.");
                    case VTSuperResolutionScalerConfigurationModelStatusReady:
                        break;
                }
            }
            return config;
        }
        case Noise:
            if (!VTTemporalNoiseFilterConfiguration.isSupported)
                fail(@"VideoToolbox temporal denoising is unsupported on this Mac. Check opencut system inspect.");
            return [[VTTemporalNoiseFilterConfiguration alloc]
                initWithFrameWidth:width frameHeight:height sourcePixelFormat:NV12];
    }
}

API_AVAILABLE(macos(26.0))
static VTFrameProcessorFrame *makeFrame(NSDictionary *attributes, int width, int height, OSType format, CMTime pts) {
    NSMutableDictionary *resolved = [attributes mutableCopy];
    resolved[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey] = @(format);
    resolved[(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey] = @{};
    CVPixelBufferRef buffer = NULL;
    OSStatus status = CVPixelBufferCreate(NULL, width, height, format, (__bridge CFDictionaryRef)resolved, &buffer);
    if (status || !buffer)
        fail([NSString stringWithFormat:@"Cannot allocate VideoToolbox enhancement buffer (%d).", status]);
    VTFrameProcessorFrame *frame = [[VTFrameProcessorFrame alloc] initWithBuffer:buffer presentationTimeStamp:pts];
    CVPixelBufferRelease(buffer);
    if (!frame) fail(@"VideoToolbox rejected an enhancement frame buffer.");
    return frame;
}

// The offline processor uses RGBA half-float surfaces. Only one packed RGBA8
// row is needed to move a surface across the pipe.
static void transfer(FILE *file, CVPixelBufferRef buffer, BOOL write, uint8_t *packed) {
    CVPixelBufferLockFlags flags = write ? kCVPixelBufferLock_ReadOnly : 0;
    if (CVPixelBufferLockBaseAddress(buffer, flags)) fail(@"Could not lock an enhancement buffer.");
    BOOL planar = CVPixelBufferIsPlanar(buffer);
    size_t planes = planar ? CVPixelBufferGetPlaneCount(buffer) : 1;
    size_t width = CVPixelBufferGetWidth(buffer);
    for (size_t plane = 0; plane < planes; plane++) {
        uint8_t *base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane) : CVPixelBufferGetBaseAddress(buffer);
        size_t stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) : CVPixelBufferGetBytesPerRow(buffer);
        size_t rows = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : CVPixelBufferGetHeight(buffer);
        size_t bytes = planar ? width : width * 4;
        if (planar && stride == width) { bytes *= rows; rows = 1; }
        for (size_t y = 0; y < rows; y++) {
            uint8_t *row = base + y * stride;
            uint8_t *wire = planar ? row : packed;
            _Float16 *rgba = (_Float16 *)row;
            if (write && !planar)
                for (size_t i = 0; i < bytes; i++)
                    wire[i] = (uint8_t)lrintf(fminf(1, fmaxf(0, rgba[i])) * 255);
            size_t size = write ? fwrite(wire, 1, bytes, file) : fread(wire, 1, bytes, file);
            if (size != bytes)
                fail(write ? @"Could not write an enhanced frame." : @"Decoded enhancement frame was truncated.");
            if (!write && !planar)
                for (size_t i = 0; i < bytes; i++) rgba[i] = (_Float16)(wire[i] / 255.0f);
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, flags);
}

@interface InputFrame : NSObject
@property(nonatomic, strong) VTFrameProcessorFrame *frame API_AVAILABLE(macos(26.0));
@property(nonatomic) BOOL cut;
@end
@implementation InputFrame
@end

API_AVAILABLE(macos(26.0))
static InputFrame *readFrame(FILE *timing, int64_t index, Options options, int64_t *origin,
                             NSDictionary *attributes, OSType format, uint8_t *row) {
    char line[256];
    if (!fgets(line, sizeof(line), timing)) {
        if (ferror(timing)) fail(@"Cannot read decoded enhancement frame timing.");
        return nil;
    }
    long long frame, pts;
    double score;
    if (sscanf(line, "frame:%lld pts:%lld", &frame, &pts) != 2 || frame != index ||
        !fgets(line, sizeof(line), timing) ||
        sscanf(line, "lavfi.scd.score=%lf", &score) != 1 || !isfinite(score))
        fail(@"Decoded enhancement frame timing or scene scores are missing.");
    if (index == 0) *origin = pts;
    double expected = (double)index * options.frameTicks * 1000000 / options.clock;
    if (index >= options.count || fabs((double)pts - *origin - expected) > options.rounding)
        fail(@"AI enhancement needs a constant frame cadence. Convert variable-rate input with a frameRate recipe first.");
    InputFrame *input = [InputFrame new];
    input.cut = score >= 8;
    input.frame = makeFrame(attributes, options.width, options.height, format,
        CMTimeMake(index * options.frameTicks, options.clock));
    transfer(stdin, input.frame.buffer, NO, row);
    return input;
}

API_AVAILABLE(macos(26.0))
static void enhance(Options options) {
    id<VTFrameProcessorConfiguration> config = configuration(options);
    OSType format = options.mode == Video ? RGBAHalf : NV12;
    id formats = config.destinationPixelBufferAttributes[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey];
    if (![config.frameSupportedPixelFormats containsObject:@(format)] ||
        !([formats isEqual:@(format)] || ([formats isKindOfClass:NSArray.class] && [formats containsObject:@(format)])))
        fail([NSString stringWithFormat:@"VideoToolbox rejected the dimensions or pixel format for %dx%d at %.1f×. Check opencut system inspect.", options.width, options.height, options.scale]);

    NSInteger pastCount = options.mode == Video ? 1 : 0;
    NSInteger futureCount = 0;
    if (options.mode == Noise) {
        VTTemporalNoiseFilterConfiguration *noise = (id)config;
        pastCount = noise.previousFrameCount;
        futureCount = noise.nextFrameCount;
    }
    NSInteger buffers = pastCount + futureCount + (options.mode == Video ? 3 : 2);
    if (buffers > options.frameBudget)
        fail([NSString stringWithFormat:@"AI enhancement requires a buffer limit of at least %ld frames.", (long)buffers]);

    VTFrameProcessor *processor = [VTFrameProcessor new];
    NSError *error = nil;
    if (![processor startSessionWithConfiguration:config error:&error])
        fail([NSString stringWithFormat:@"VideoToolbox could not initialize the enhancement model: %@", error]);

    FILE *timing = fdopen(3, "r");
    if (!timing) fail(@"Cannot open decoded enhancement timing pipe.");
    int width = (int)(options.width * options.scale), height = (int)(options.height * options.scale);
    uint8_t *row = format == RGBAHalf ? malloc((size_t)width * 4) : NULL;
    if (format == RGBAHalf && !row) fail(@"Could not allocate enhancement transfer row.");
    NSMutableArray<InputFrame *> *queue = [NSMutableArray array];
    NSMutableArray<VTFrameProcessorFrame *> *past = [NSMutableArray array];
    VTFrameProcessorFrame *previousOutput = nil;
    int64_t index = 0, origin = 0, calls = 0;
    BOOL eof = NO, reset = YES;
    while (YES) @autoreleasepool {
        while (!eof && queue.count <= (NSUInteger)futureCount) {
            InputFrame *input = readFrame(timing, index + (int64_t)queue.count, options,
                &origin, config.sourcePixelBufferAttributes, format, row);
            if (input) [queue addObject:input];
            else eof = YES;
        }
        if (!queue.count) break;
        InputFrame *input = queue.firstObject;
        if (input.cut) {
            [past removeAllObjects];
            previousOutput = nil;
            reset = YES;
        }
        NSMutableArray<VTFrameProcessorFrame *> *future = [NSMutableArray array];
        for (NSUInteger i = 1; i < queue.count && !queue[i].cut; i++) [future addObject:queue[i].frame];
        VTFrameProcessorFrame *result = input.frame;
        if (options.mode != Noise || past.count || future.count) {
            result = makeFrame(config.destinationPixelBufferAttributes, width, height, format,
                input.frame.presentationTimeStamp);
            id<VTFrameProcessorParameters> params;
            switch (options.mode) {
                case Fast:
                    params = [[VTLowLatencySuperResolutionScalerParameters alloc]
                        initWithSourceFrame:input.frame destinationFrame:result];
                    break;
                case Video:
                    params = [[VTSuperResolutionScalerParameters alloc]
                        initWithSourceFrame:input.frame previousFrame:past.lastObject previousOutputFrame:previousOutput
                        opticalFlow:nil submissionMode:reset ? VTSuperResolutionScalerParametersSubmissionModeRandom :
                        VTSuperResolutionScalerParametersSubmissionModeSequential destinationFrame:result];
                    break;
                case Noise:
                    params = [[VTTemporalNoiseFilterParameters alloc]
                        initWithSourceFrame:input.frame nextFrames:future previousFrames:past destinationFrame:result
                        filterStrength:options.strength hasDiscontinuity:reset];
                    break;
            }
            if (!params || ![processor processWithParameters:params error:&error])
                fail([NSString stringWithFormat:@"VideoToolbox enhancement failed at frame %lld: %@", (long long)index, error ?: @"invalid frame parameters"]);
            calls++;
            reset = NO;
        }
        transfer(stdout, result.buffer, YES, row);
        if (pastCount) {
            [past addObject:input.frame];
            if (past.count > (NSUInteger)pastCount) [past removeObjectAtIndex:0];
        }
        if (options.mode == Video) previousOutput = result;
        [queue removeObjectAtIndex:0];
        index++;
    }
    if (index != options.count || fgetc(stdin) != EOF || ferror(stdin))
        fail(@"AI enhancement decoded a different number of frames than expected. Check source timing or convert to a constant frame rate.");
    if (!calls) fail(@"AI enhancement did not run inference on any frames. Temporal noise filtering needs at least two frames from the same shot.");
    if (fflush(stdout)) fail(@"Could not flush the enhanced video stream.");
    fclose(timing);
    free(row);
    [processor endSession];
}

int main(int argc, const char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(OPENCUT_VERSION);
        return 0;
    }
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            if (argc != 11) fail(@"Invalid enhancement worker arguments.");
            Mode mode;
            if (!strcmp(argv[1], "fast")) mode = Fast;
            else if (!strcmp(argv[1], "video")) mode = Video;
            else if (!strcmp(argv[1], "noise")) mode = Noise;
            else fail(@"Unknown VideoToolbox enhancement mode.");
            Options options = {
                .width = (int)integer(argv[2], 16384),
                .height = (int)integer(argv[3], 16384),
                .scale = number(argv[4], 1, 4),
                .count = integer(argv[5], INT64_MAX / 1000000),
                .clock = (int)integer(argv[6], 1000000),
                .frameTicks = (int)integer(argv[7], 1000000),
                .rounding = number(argv[8], 1, 2001),
                .strength = number(argv[9], 0, 1),
                .frameBudget = (int)integer(argv[10], 256),
                .mode = mode,
            };
            enhance(options);
        } else fail(@"VideoToolbox AI enhancement requires macOS 26 or later.");
    }
    return EXIT_SUCCESS;
}
