import { lstat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
try {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Refuse to clean an unexpected build path');
  await rm(directory, { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
