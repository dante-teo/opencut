import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  arch,
  availableParallelism,
  cpus,
  machine,
  release,
  totalmem,
} from 'node:os';
import { fileURLToPath } from 'node:url';
import { getApplicationInfo } from '@opencut/core';
import {
  hostRenderResources,
  renderQualityProfiles,
  sampleMemoryPressure,
} from '@opencut/media';

export const systemHelp =
  'Usage: opencut system inspect [--json]\nReport hardware and probe local VideoToolbox capabilities.';

const exec = promisify(execFile);

interface HardwareProfile {
  SPHardwareDataType?: {
    chip_type?: string;
    cpu_type?: string;
    machine_model?: string;
  }[];
  SPDisplaysDataType?: {
    _name?: string;
    sppci_model?: string;
    sppci_cores?: string;
  }[];
}

export interface MetalDevice {
  name: string;
  hasUnifiedMemory: boolean;
  recommendedMaxWorkingSetBytes: number;
  maxBufferBytes: number;
}

export interface FrameProcessorProbe {
  minimumMacOS: string;
  status: 'os-unavailable' | 'hardware-unsupported' | 'reported-supported';
  testedSizes?: {
    configurations: { status: string; modelStatus?: string }[];
  }[];
}

interface NativeProbe {
  gpuDevices: MetalDevice[];
  codecs: {
    encoders: Record<
      string,
      { availableAt1920x1080: boolean; osStatus: number }
    >;
    decoders: Record<string, boolean>;
  };
  frameProcessors: Record<string, FrameProcessorProbe>;
  thermalState: number;
}

async function query<T>(path: string, args: string[] = []): Promise<T> {
  const { stdout } = await exec(path, args, { timeout: 15000 });
  return JSON.parse(stdout) as T;
}

async function probeVideoToolbox() {
  if (process.platform !== 'darwin')
    return {
      status: 'not-applicable' as const,
      reason: 'VideoToolbox is only available on macOS.',
    };
  try {
    const path = fileURLToPath(
      new URL('../dist/system-probe', import.meta.url),
    );
    const { stdout } = await exec(path, ['--version'], { timeout: 3000 });
    const version = stdout.trim();
    if (version !== getApplicationInfo().version)
      return {
        status: 'unavailable' as const,
        reason: 'Native system probe version does not match OpenCut.',
      };
    return {
      status: 'probed' as const,
      version,
      ...(await query<NativeProbe>(path)),
    };
  } catch (failure) {
    const error = failure as NodeJS.ErrnoException;
    return {
      status: 'unavailable' as const,
      reason:
        error.code === 'ENOENT'
          ? 'Native probe is missing. Reinstall OpenCut or rebuild from source with a macOS 26+ SDK.'
          : `Native probe failed (${error.code ?? error.name}).`,
    };
  }
}

export async function inspectSystem() {
  const mac = process.platform === 'darwin';
  const [profile, version, probe, memoryPressure] = await Promise.all([
    mac
      ? query<HardwareProfile>('/usr/sbin/system_profiler', [
          '-json',
          'SPHardwareDataType',
          'SPDisplaysDataType',
        ]).catch(() => null)
      : null,
    mac
      ? exec('/usr/bin/sw_vers', ['-productVersion'], { timeout: 3000 }).then(
          ({ stdout }) => stdout.trim(),
          () => null,
        )
      : null,
    probeVideoToolbox(),
    sampleMemoryPressure(),
  ]);
  const hardware = profile?.SPHardwareDataType?.[0];
  const chip = hardware?.chip_type;
  const appleSilicon = chip?.startsWith('Apple ') ?? false;
  const devices = probe.status === 'probed' ? probe.gpuDevices : [];
  const gpu = (profile?.SPDisplaysDataType ?? []).map((display) => {
    const cores = Number.parseInt(display.sppci_cores ?? '', 10);
    return {
      name: display.sppci_model ?? display._name ?? null,
      cores: Number.isSafeInteger(cores) ? cores : null,
    };
  });
  const cpu = cpus();
  const unified =
    appleSilicon || devices.some((device) => device.hasUnifiedMemory);
  return {
    systemInspectVersion: 1,
    os: {
      platform: process.platform,
      macOSVersion: version,
      kernelRelease: release(),
    },
    architecture: {
      host: appleSilicon ? 'arm64' : machine(),
      process: arch(),
    },
    model: hardware?.machine_model ?? null,
    cpu: {
      name: chip ?? hardware?.cpu_type ?? (cpu[0]?.model || null),
      logicalCores: cpu.length || null,
      availableParallelism: availableParallelism(),
    },
    gpu: gpu.length ? gpu : devices.map(({ name }) => ({ name, cores: null })),
    memory: {
      installedBytes: totalmem() || null,
      unified: mac && !unified && !hardware && !devices.length ? null : unified,
    },
    videoToolbox: probe,
    rendering: {
      defaults: { preview: 'fast', render: 'quality' },
      profiles: renderQualityProfiles,
      maximumAiMatchesQuality: true,
      interpolationProcessors: {
        fast: 'low-latency-interpolation',
        quality: 'frame-rate-conversion-quality',
      },
      superResolutionProcessors: {
        fast: 'low-latency-super-resolution',
        quality: 'video-super-resolution',
      },
      resources: { ...hostRenderResources(), memoryPressure },
    },
  };
}

export function formatSystem(
  result: Awaited<ReturnType<typeof inspectSystem>>,
) {
  return [
    `System: ${result.model ?? result.os.platform} (${result.architecture.host})`,
    `OS: ${result.os.macOSVersion ? `macOS ${result.os.macOSVersion}` : result.os.kernelRelease}`,
    `CPU: ${result.cpu.name ?? 'unknown'} (${result.cpu.logicalCores ?? '?'} logical cores)`,
    `GPU: ${result.gpu.map((gpu) => gpu.name).join(', ') || 'unknown'}`,
    `Installed memory: ${result.memory.installedBytes ?? 'unknown'} bytes${result.memory.unified ? ' (unified)' : ''}`,
    `VideoToolbox: ${result.videoToolbox.status} (use --json for details)`,
    '',
  ].join('\n');
}
