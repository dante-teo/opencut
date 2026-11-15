#pragma once
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import <VideoToolbox/VTFrameProcessor_LowLatencyFrameInterpolation.h>
#import <VideoToolbox/VTFrameProcessor_LowLatencySuperResolutionScaler.h>
#import <VideoToolbox/VTFrameProcessor_TemporalNoiseFilter.h>

static NSString *const FRC = @"frame-rate-conversion";
static NSString *const LLI = @"low-latency-interpolation";
static NSString *const SR = @"video-super-resolution";
static NSString *const LLSR = @"low-latency-super-resolution";
static NSString *const TN = @"temporal-noise-filter";
static const OSType NV12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;

API_AVAILABLE(macos(15.4))
static BOOL supports(NSString *effect) {
    if ([effect isEqual:FRC]) {
        if (@available(macOS 26.0, *)) return VTFrameRateConversionConfiguration.isSupported;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        return VTFrameRateConversionConfiguration.processorSupported;
#pragma clang diagnostic pop
    }
    if (@available(macOS 26.0, *)) {
        if ([effect isEqual:LLI]) return VTLowLatencyFrameInterpolationConfiguration.isSupported;
        if ([effect isEqual:SR]) return VTSuperResolutionScalerConfiguration.isSupported;
        if ([effect isEqual:LLSR]) return VTLowLatencySuperResolutionScalerConfiguration.isSupported;
        if ([effect isEqual:TN]) return VTTemporalNoiseFilterConfiguration.isSupported;
    }
    return NO;
}

// Callers check hardware support before querying scales or creating configurations.
API_AVAILABLE(macos(15.4))
static NSArray<NSNumber *> *scales(NSString *effect, int width, int height) {
    if (@available(macOS 26.0, *)) {
        if ([effect isEqual:LLSR])
            return [VTLowLatencySuperResolutionScalerConfiguration supportedScaleFactorsForFrameWidth:width frameHeight:height];
        if ([effect isEqual:SR]) return VTSuperResolutionScalerConfiguration.supportedScaleFactors;
    }
    return @[];
}

API_AVAILABLE(macos(15.4))
static id<VTFrameProcessorConfiguration> configure(NSString *effect, int width, int height, double scale) {
    if ([effect isEqual:FRC]) return [[VTFrameRateConversionConfiguration alloc]
        initWithFrameWidth:width frameHeight:height usePrecomputedFlow:NO
        qualityPrioritization:VTFrameRateConversionConfigurationQualityPrioritizationNormal
        revision:VTFrameRateConversionConfiguration.defaultRevision];
    if (@available(macOS 26.0, *)) {
        if ([effect isEqual:LLI]) return [[VTLowLatencyFrameInterpolationConfiguration alloc]
            initWithFrameWidth:width frameHeight:height numberOfInterpolatedFrames:1];
        if ([effect isEqual:TN]) return [[VTTemporalNoiseFilterConfiguration alloc]
            initWithFrameWidth:width frameHeight:height sourcePixelFormat:NV12];
        if (![scales(effect, width, height) containsObject:@(scale)]) return nil;
        if ([effect isEqual:LLSR]) return [[VTLowLatencySuperResolutionScalerConfiguration alloc]
            initWithFrameWidth:width frameHeight:height scaleFactor:scale];
        if ([effect isEqual:SR]) return [[VTSuperResolutionScalerConfiguration alloc]
            initWithFrameWidth:width frameHeight:height scaleFactor:(NSInteger)scale
            inputType:VTSuperResolutionScalerConfigurationInputTypeVideo usePrecomputedFlow:NO
            qualityPrioritization:VTSuperResolutionScalerConfigurationQualityPrioritizationNormal
            revision:VTSuperResolutionScalerConfigurationRevision1];
    }
    return nil;
}

API_AVAILABLE(macos(15.4))
static NSString *modelStatus(id<VTFrameProcessorConfiguration> config) {
    if (@available(macOS 26.0, *)) {
        if ([(id)config isKindOfClass:VTSuperResolutionScalerConfiguration.class]) {
            switch ([(VTSuperResolutionScalerConfiguration *)config configurationModelStatus]) {
                case VTSuperResolutionScalerConfigurationModelStatusReady: return @"ready";
                case VTSuperResolutionScalerConfigurationModelStatusDownloadRequired: return @"download-required";
                case VTSuperResolutionScalerConfigurationModelStatusDownloading: return @"downloading";
            }
        }
    }
    return @"not-reported";
}

static void printJSON(id object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:NULL];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}
