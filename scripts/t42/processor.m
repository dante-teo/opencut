#import "../../apps/cli/native/video-toolbox.h"
#import <sys/resource.h>

static double now(void) { return NSProcessInfo.processInfo.systemUptime; }

static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

// FFmpeg handles decode, orientation and encode. This process uses tightly packed
// NV12 (420v) or RGBA8 on disk and attributes supplied by the Apple configuration.
API_AVAILABLE(macos(15.4))
static VTFrameProcessorFrame *makeFrame(NSDictionary *attributes, int w, int h, OSType format, CMTime pts) {
    CVPixelBufferRef buffer = NULL;
    NSMutableDictionary *resolved = [attributes mutableCopy];
    resolved[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey] = @(format);
    resolved[(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey] = @{};
    OSStatus status = CVPixelBufferCreate(NULL, w, h, format, (__bridge CFDictionaryRef)resolved, &buffer);
    if (status) fail([NSString stringWithFormat:@"Pixel buffer creation failed: %d", status]);
    VTFrameProcessorFrame *frame = [[VTFrameProcessorFrame alloc] initWithBuffer:buffer presentationTimeStamp:pts];
    CVPixelBufferRelease(buffer);
    if (!frame) fail(@"VideoToolbox rejected the frame buffer");
    return frame;
}

static BOOL transfer(FILE *file, CVPixelBufferRef buffer, BOOL write) {
    if (CVPixelBufferLockBaseAddress(buffer, write ? kCVPixelBufferLock_ReadOnly : 0))
        fail(@"Could not lock pixel buffer");
    BOOL planar = CVPixelBufferIsPlanar(buffer), complete = YES;
    size_t planes = planar ? CVPixelBufferGetPlaneCount(buffer) : 1;
    size_t width = CVPixelBufferGetWidth(buffer);
    uint8_t *row = planar ? NULL : malloc(width * 4);
    if (!planar && !row) fail(@"Could not allocate row");
    for (size_t plane = 0; plane < planes && complete; plane++) {
        uint8_t *base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane) : CVPixelBufferGetBaseAddress(buffer);
        size_t rows = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : CVPixelBufferGetHeight(buffer);
        size_t stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) : CVPixelBufferGetBytesPerRow(buffer);
        size_t bytes = planar ? width : width * 4;
        for (size_t y = 0; y < rows; y++) {
            uint8_t *target = base + y * stride;
            uint8_t *packed = planar ? target : row;
            _Float16 *rgba = (_Float16 *)target;
            if (write && !planar)
                for (size_t i = 0; i < bytes; i++) packed[i] = (uint8_t)lrintf(fminf(1, fmaxf(0, rgba[i])) * 255);
            size_t n = write ? fwrite(packed, 1, bytes, file) : fread(packed, 1, bytes, file);
            if (n != bytes) {
                if (write || ferror(file) || n || y || plane) fail(@"Incomplete raw video frame");
                complete = NO;
                break;
            }
            if (!write && !planar)
                for (size_t i = 0; i < bytes; i++) rgba[i] = (_Float16)((float)packed[i] / 255);
        }
    }
    free(row);
    CVPixelBufferUnlockBaseAddress(buffer, write ? kCVPixelBufferLock_ReadOnly : 0);
    return complete;
}

API_AVAILABLE(macos(15.4))
static BOOL process(NSString *effect, VTFrameProcessor *processor, VTFrameProcessorFrame *current,
                    VTFrameProcessorFrame *destination, VTFrameProcessorFrame *previousOutput,
                    NSArray *past, NSArray *future, BOOL discontinuity, NSError **error) {
    id<VTFrameProcessorParameters> params = nil;
    if ([effect isEqual:FRC]) params = [[VTFrameRateConversionParameters alloc]
        initWithSourceFrame:current nextFrame:future.firstObject opticalFlow:nil
        interpolationPhase:@[@0.5] submissionMode:discontinuity ?
        VTFrameRateConversionParametersSubmissionModeRandom : VTFrameRateConversionParametersSubmissionModeSequential
        destinationFrames:@[destination]];
    if (@available(macOS 26.0, *)) {
        if ([effect isEqual:LLI]) params = [[VTLowLatencyFrameInterpolationParameters alloc]
            initWithSourceFrame:future.firstObject previousFrame:current interpolationPhase:@[@0.5]
            destinationFrames:@[destination]];
        if ([effect isEqual:LLSR]) params = [[VTLowLatencySuperResolutionScalerParameters alloc]
            initWithSourceFrame:current destinationFrame:destination];
        if ([effect isEqual:SR]) params = [[VTSuperResolutionScalerParameters alloc]
            initWithSourceFrame:current previousFrame:past.lastObject previousOutputFrame:previousOutput
            opticalFlow:nil submissionMode:discontinuity ?
            VTSuperResolutionScalerParametersSubmissionModeRandom : VTSuperResolutionScalerParametersSubmissionModeSequential
            destinationFrame:destination];
        if ([effect isEqual:TN]) params = [[VTTemporalNoiseFilterParameters alloc]
            initWithSourceFrame:current nextFrames:future previousFrames:past destinationFrame:destination
            filterStrength:0.5 hasDiscontinuity:discontinuity];
    }
    if (!params) fail(@"VideoToolbox rejected the frame parameters");
    return [processor processWithParameters:params error:error];
}

API_AVAILABLE(macos(15.4))
static void run(NSString *effect, int w, int h, int fps, double scale, int cut, const char *inPath, const char *outPath) {
    if (w < 2 || h < 2 || w > 4096 || h > 4096 || w % 2 || h % 2 || fps < 1 || fps > 120 ||
        !(scale > 0 && scale <= 4) || cut < 0) fail(@"Invalid size, rate, scale or cut index");
    if (!supports(effect)) fail(@"Processor unavailable on this OS or hardware");
    BOOL interpolate = [effect isEqual:FRC] || [effect isEqual:LLI];
    BOOL videoSR = [effect isEqual:SR], denoise = [effect isEqual:TN];
    BOOL scaled = videoSR || [effect isEqual:LLSR];
    if (!scaled && scale != 1) fail(@"This mode requires scale 1");
    id<VTFrameProcessorConfiguration> config = configure(effect, w, h, scale);
    if (!config) fail(@"Configuration rejected for this size, scale or pixel format");
    NSString *model = modelStatus(config);
    if (videoSR && ![model isEqual:@"ready"]) fail([@"Video super-resolution model: " stringByAppendingString:model]);
    OSType format = ([effect isEqual:FRC] || videoSR) ? kCVPixelFormatType_64RGBAHalf : NV12;
    if (![config.frameSupportedPixelFormats containsObject:@(format)]) fail(@"Prototype input pixel format unsupported");
    int ow = w * scale, oh = h * scale;
    if (ow % 2 || oh % 2 || ow != w * scale || oh != h * scale) fail(@"Output dimensions must be even integers");
    NSError *error = nil;
    VTFrameProcessor *processor = [VTFrameProcessor new];
    double start = now();
    if (![processor startSessionWithConfiguration:config error:&error]) fail([NSString stringWithFormat:@"Session start: %@", error]);
    double setup = now() - start, readSeconds = 0, writeSeconds = 0, inference = 0, first = 0;
    double firstWindow = 0, lastWindow = 0;
    int previous = videoSR ? 1 : 0, next = interpolate ? 1 : 0;
    if (@available(macOS 26.0, *)) {
        if (denoise) {
            VTTemporalNoiseFilterConfiguration *noise = (id)config;
            previous = (int)noise.previousFrameCount;
            next = (int)noise.nextFrameCount;
        }
    }
    FILE *input = fopen(inPath, "rb"), *output = fopen(outPath, "wbx");
    if (!input || !output) fail(@"Could not open input or create a new output");
    int index = 0, loaded = 0, calls = 0, resultFrames = 0;
    BOOL eof = NO, reset = YES;
    NSMutableArray<VTFrameProcessorFrame *> *queue = [NSMutableArray array], *past = [NSMutableArray array];
    VTFrameProcessorFrame *previousOutput = nil;
    while (YES) @autoreleasepool {
        while (!eof && queue.count <= (NSUInteger)next) {
            double t = now();
            VTFrameProcessorFrame *frame = makeFrame(config.sourcePixelBufferAttributes, w, h, format, CMTimeMake(loaded++, fps));
            if (transfer(input, frame.buffer, NO)) [queue addObject:frame];
            else eof = YES;
            readSeconds += now() - t;
        }
        if (!queue.count) break;
        if (index == cut) {
            [past removeAllObjects];
            previousOutput = nil;
            reset = YES;
        }
        VTFrameProcessorFrame *current = queue.firstObject, *result = current;
        NSMutableArray *future = [NSMutableArray array];
        for (NSUInteger i = 1; i < queue.count && (cut == 0 || index >= cut || index + (int)i < cut); i++)
            [future addObject:queue[i]];
        if (interpolate) {
            double t = now();
            transfer(output, current.buffer, YES); resultFrames++;
            writeSeconds += now() - t;
        }
        if ((interpolate && future.count) || scaled || (denoise && (past.count || future.count))) {
            CMTime pts = interpolate ? CMTimeMake(index * 2 + 1, fps * 2) : current.presentationTimeStamp;
            result = makeFrame(config.destinationPixelBufferAttributes, ow, oh, format, pts);
            double t = now();
            if (!process(effect, processor, current, result, previousOutput, past, future, reset, &error))
                fail([NSString stringWithFormat:@"Processing frame %d: %@", index, error]);
            double elapsed = now() - t;
            if (!calls++) first = elapsed;
            if (calls <= 30) firstWindow += elapsed;
            if (index >= 30) lastWindow += elapsed;
            inference += elapsed;
            reset = NO;
        }
        double t = now();
        transfer(output, result.buffer, YES); resultFrames++;
        writeSeconds += now() - t;
        if (previous) {
            [past addObject:current];
            if (past.count > (NSUInteger)previous) [past removeObjectAtIndex:0];
        }
        if (videoSR) previousOutput = result;
        [queue removeObjectAtIndex:0];
        index++;
    }
    if (fclose(output) || !calls) fail(@"No processed frames or output close failed");
    fclose(input);
    [processor endSession];
    struct rusage usage;
    getrusage(RUSAGE_SELF, &usage);
    printJSON(@{@"inputFrames": @(index), @"outputFrames": @(resultFrames), @"processCalls": @(calls),
        @"sessionStartSeconds": @(setup), @"firstCallSeconds": @(first), @"processSeconds": @(inference),
        @"first30CallSeconds": @(firstWindow), @"afterInputFrame30ProcessSeconds": @(lastWindow),
        @"rawReadAndConvertSeconds": @(readSeconds), @"rawWriteAndConvertSeconds": @(writeSeconds),
        @"peakRssBytes": @(usage.ru_maxrss), @"thermalState": @(NSProcessInfo.processInfo.thermalState)});
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 9) fail(@"Usage: processor EFFECT WIDTH HEIGHT FPS SCALE CUT_FRAME INPUT_RAW NEW_OUTPUT_RAW (cut 0 = no internal cut)");
        if (@available(macOS 15.4, *)) {
            run(@(argv[1]), atoi(argv[2]), atoi(argv[3]), atoi(argv[4]), atof(argv[5]), atoi(argv[6]), argv[7], argv[8]);
        } else fail(@"Requires macOS 15.4 or later");
    }
}
