import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { purgeCallRecordings } from './purge-call-recordings';
it('removes exact call files, rejects path injection, keeps other calls and tolerates retry', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'synexa-call-export-'));
  const call = randomUUID();
  const other = randomUUID();
  const target = join(root, `synexa-${call}.wav`);
  const unrelated = join(root, `${other}.wav`);
  try {
    await fs.writeFile(target, 'call audio');
    await fs.writeFile(unrelated, 'other audio');
    await purgeCallRecordings([root], [call, '../' + other, 'not-a-uuid']);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('other audio');
    await purgeCallRecordings([root], [call]);
  } finally {
    await fs.unlink(target).catch(() => undefined);
    await fs.unlink(unrelated).catch(() => undefined);
    await fs.rmdir(root);
  }
});
