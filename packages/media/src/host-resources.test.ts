import { availableParallelism, totalmem } from 'node:os';
import { expect, it, vi } from 'vitest';
import { hostRenderResources } from './host-resources.js';

vi.mock('node:os', () => ({
  availableParallelism: vi.fn(),
  totalmem: vi.fn(),
}));

it.each([
  { parallelism: 3, memoryGiB: 7, batchWorkers: 2, recipeWorkers: 1 },
  { parallelism: 3, memoryGiB: 2, batchWorkers: 1, recipeWorkers: 1 },
  { parallelism: 1, memoryGiB: 7, batchWorkers: 1, recipeWorkers: 1 },
])(
  'bounds worker counts on a $parallelism-core host with $memoryGiB GiB',
  (host) => {
    vi.mocked(availableParallelism).mockReturnValue(host.parallelism);
    vi.mocked(totalmem).mockReturnValue(host.memoryGiB * 1024 ** 3);
    expect(hostRenderResources()).toMatchObject({
      batchWorkers: host.batchWorkers,
      recipeWorkers: host.recipeWorkers,
    });
  },
);
