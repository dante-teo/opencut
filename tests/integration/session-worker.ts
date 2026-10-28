import { ProjectSession } from '../../apps/desktop/src/main/project-session.js';
import { acquireProjectWriter } from '@opencut/core/node';

const path = process.argv[2]!;
if (process.argv[3] === 'pending') {
  const writer = await acquireProjectWriter(path);
  await writer.update(async () => {
    process.send?.({ ok: true });
    return new Promise(() => {});
  });
}
const session = new ProjectSession(
  {
    open: async () => path,
    save: async () => null,
    unsaved: async () => 'discard',
  },
  undefined,
  () => {
    if (process.argv[3] === 'crash-after-commit')
      process.kill(process.pid, 'SIGKILL');
  },
);
process.send?.(await session.run('open'));
process.on('message', () => {
  void session.run('close').then(() => process.exit(0));
});
process.on('disconnect', () => {
  void session.dispose().then(() => process.exit(0));
});
