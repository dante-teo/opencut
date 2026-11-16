#import "video-toolbox.h"
#import <Metal/Metal.h>

static NSDictionary *codecs(void) {
    NSDictionary *types = @{
        @"h264": @(kCMVideoCodecType_H264), @"hevc": @(kCMVideoCodecType_HEVC),
        @"av1": @(kCMVideoCodecType_AV1), @"vp9": @(kCMVideoCodecType_VP9),
        @"prores422": @(kCMVideoCodecType_AppleProRes422),
        @"prores4444": @(kCMVideoCodecType_AppleProRes4444)
    };
    NSMutableDictionary *encoders = [NSMutableDictionary dictionary];
    NSMutableDictionary *decoders = [NSMutableDictionary dictionary];
    for (NSString *name in types) {
        CMVideoCodecType codec = [types[name] unsignedIntValue];
        decoders[name] = (__bridge id)(VTIsHardwareDecodeSupported(codec) ? kCFBooleanTrue : kCFBooleanFalse);
        VTCompressionSessionRef session = NULL;
        NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES};
        OSStatus status = VTCompressionSessionCreate(NULL, 1920, 1080, codec,
            (__bridge CFDictionaryRef)spec, NULL, NULL, NULL, NULL, &session);
        if (!status) status = VTCompressionSessionPrepareToEncodeFrames(session);
        encoders[name] = @{@"availableAt1920x1080": (__bridge id)(status == noErr ? kCFBooleanTrue : kCFBooleanFalse), @"osStatus": @(status)};
        if (session) {
            VTCompressionSessionInvalidate(session);
            CFRelease(session);
        }
    }
    return @{@"encoders": encoders, @"decoders": decoders};
}

API_AVAILABLE(macos(15.4))
static NSMutableDictionary *configurationInfo(id<VTFrameProcessorConfiguration> config) {
    if (!config) return [@{@"status": @"configuration-rejected"} mutableCopy];
    id formats = config.destinationPixelBufferAttributes[(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey];
    NSArray *destinationFormats = [formats isKindOfClass:NSNumber.class] ? @[formats] : (formats ?: @[]);
    NSMutableDictionary *info = [@{
        @"status": @"configuration-accepted",
        @"sourcePixelFormats": config.frameSupportedPixelFormats ?: @[],
        @"destinationPixelFormats": destinationFormats,
        @"modelStatus": modelStatus(config)
    } mutableCopy];
    if ([(id)config isKindOfClass:VTFrameRateConversionConfiguration.class]) {
        VTFrameRateConversionConfiguration *conversion = (id)config;
        info[@"revision"] = @(conversion.revision);
        info[@"qualityPriority"] = conversion.qualityPrioritization ==
            VTFrameRateConversionConfigurationQualityPrioritizationQuality ? @"quality" : @"normal";
    }
    if (@available(macOS 26.0, *)) {
        if ([(id)config isKindOfClass:VTSuperResolutionScalerConfiguration.class]) {
            info[@"revision"] = @(((VTSuperResolutionScalerConfiguration *)config).revision);
        }
        if ([(id)config isKindOfClass:VTTemporalNoiseFilterConfiguration.class]) {
            VTTemporalNoiseFilterConfiguration *noise = (id)config;
            info[@"previousFrames"] = @(noise.previousFrameCount);
            info[@"nextFrames"] = @(noise.nextFrameCount);
        }
    }
    return info;
}

static NSDictionary *effectInfo(NSString *effect) {
    BOOL earliest = [effect isEqual:FRC] || [effect isEqual:FRCQuality];
    NSMutableDictionary *info = [@{
        @"minimumMacOS": earliest ? @"15.4" : @"26.0",
        @"status": @"os-unavailable"
    } mutableCopy];
    if (!earliest) {
        if (@available(macOS 26.0, *)) {} else return info;
    }
    if (@available(macOS 15.4, *)) {
        if (!supports(effect)) {
            info[@"status"] = @"hardware-unsupported";
            return info;
        }
        info[@"status"] = @"reported-supported";
        NSMutableArray *cases = [NSMutableArray array];
        for (NSArray<NSNumber *> *dimensions in @[@[@640,@360], @[@1280,@720], @[@720,@1280],
                                                    @[@1920,@1080], @[@1080,@1920], @[@3840,@2160], @[@2160,@3840]]) {
            int w = dimensions[0].intValue, h = dimensions[1].intValue;
            BOOL scaler = [effect isEqual:SR] || [effect isEqual:LLSR];
            NSArray *factors = scaler ? scales(effect, w, h) : @[@1];
            NSMutableArray *configs = [NSMutableArray array];
            for (NSNumber *factor in factors) {
                NSMutableDictionary *config = configurationInfo(configure(effect, w, h, factor.doubleValue));
                config[@"scale"] = factor;
                [configs addObject:config];
            }
            [cases addObject:@{@"width": @(w), @"height": @(h), @"configurations": configs}];
        }
        info[@"testedSizes"] = cases;
    }
    return info;
}

int main(void) {
    @autoreleasepool {
        NSMutableArray *gpus = [NSMutableArray array];
        for (id<MTLDevice> device in MTLCopyAllDevices()) {
            [gpus addObject:@{@"name": device.name, @"hasUnifiedMemory": @(device.hasUnifiedMemory),
                @"recommendedMaxWorkingSetBytes": @(device.recommendedMaxWorkingSetSize),
                @"maxBufferBytes": @(device.maxBufferLength)}];
        }
        NSMutableDictionary *effects = [NSMutableDictionary dictionary];
        for (NSString *effect in @[FRC, FRCQuality, LLI, SR, LLSR, TN]) effects[effect] = effectInfo(effect);
        printJSON(@{@"gpuDevices": gpus, @"codecs": codecs(), @"frameProcessors": effects,
            @"thermalState": @(NSProcessInfo.processInfo.thermalState)});
    }
    return 0;
}
