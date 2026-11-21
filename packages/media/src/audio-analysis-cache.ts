import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';

const maxPayload = 64 * 1024 * 1024;
const storageBudget = 256 * 1024 * 1024;
const headerSize = 44;
const signature = 'OCF1';
const fileName = /^[a-f0-9]{64}\.fft$/;
const checksum = (data: Buffer) => createHash('sha256').update(data).digest();

export interface AudioSeries {
  count: number;
  features: Float32Array;
}

/** The private disk cache is optional. An invalid record becomes a cache miss. */
export async function openAudioAnalysisRecord(
  directory: string | undefined,
  key: string,
  signal?: AbortSignal,
) {
  if (!directory || !/^[a-f0-9]{64}$/.test(key)) return;
  const root = join(directory, `graphic-analysis-v1-${endianness()}`);
  const path = join(root, key + '.fft');
  return {
    async read(stride: number): Promise<AudioSeries | undefined> {
      try {
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.size <= headerSize ||
            info.size > headerSize + maxPayload
          )
            return;
          const record = Buffer.alloc(info.size);
          let offset = 0;
          while (offset < record.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(
              record,
              offset,
              record.length - offset,
              offset,
            );
            if (!bytesRead) return;
            offset += bytesRead;
          }
          if (record.toString('ascii', 0, 4) !== signature) return;
          const count = record.readUInt32LE(4);
          const data = record.subarray(headerSize);
          if (
            !count ||
            record.readUInt32LE(8) !== stride ||
            data.length !== count * stride * 4 ||
            !record.subarray(12, headerSize).equals(checksum(data))
          )
            return;
          return {
            count,
            features: new Float32Array(
              data.buffer,
              data.byteOffset,
              data.length / 4,
            ),
          };
        } finally {
          await handle.close();
        }
      } catch {
        signal?.throwIfAborted();
        return;
      }
    },
    async publish({ count, features }: AudioSeries, stride: number) {
      if (features.byteLength > maxPayload) return;
      const temporary = join(root, `.${key}-${randomUUID()}`);
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const owned = (await readdir(root)).filter((name) =>
          fileName.test(name),
        );
        const records = await Promise.all(
          owned.map(async (name) => {
            const file = join(root, name);
            const info = await stat(file).catch(() => undefined);
            return { file, bytes: info?.size ?? 0, newest: info?.mtimeMs ?? 0 };
          }),
        );
        let total = records.reduce(
          (sum, { bytes }) => sum + bytes,
          headerSize + features.byteLength,
        );
        for (const old of records.sort((a, b) => a.newest - b.newest)) {
          if (total <= storageBudget) break;
          signal?.throwIfAborted();
          if (old.file === path) continue;
          await rm(old.file, { force: true });
          total -= old.bytes;
        }
        const data = Buffer.from(
          features.buffer,
          features.byteOffset,
          features.byteLength,
        );
        const header = Buffer.alloc(headerSize);
        header.write(signature, 0, 'ascii');
        header.writeUInt32LE(count, 4);
        header.writeUInt32LE(stride, 8);
        checksum(data).copy(header, 12);
        await writeFile(temporary, [header, data], {
          flag: 'wx',
          mode: 0o600,
          flush: true,
          signal,
        });
        signal?.throwIfAborted();
        await rename(temporary, path);
      } catch {
        signal?.throwIfAborted();
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
  };
}
