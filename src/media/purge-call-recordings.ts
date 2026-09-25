import { promises as fs } from 'fs';
import { resolve, relative, isAbsolute } from 'path';

/** Only exact UUID filenames used by our dialplan; never recursive/fuzzy deletion. */
export async function purgeCallRecordings(
  directories: string[],
  ids: unknown[],
): Promise<void> {
  const valid = [
    ...new Set(
      ids.filter(
        (id): id is string =>
          typeof id === 'string' &&
          /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id),
      ),
    ),
  ];
  for (const directory of directories) {
    let root: string;
    try {
      root = await fs.realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const id of valid)
      for (const filename of [`${id}.wav`, `synexa-${id}.wav`]) {
        const target = resolve(root, filename);
        try {
          const actual = await fs.realpath(target);
          const within = relative(root, actual);
          if (within.startsWith('..') || isAbsolute(within))
            throw new Error('Recording outside configured directory');
          await fs.unlink(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
  }
}
