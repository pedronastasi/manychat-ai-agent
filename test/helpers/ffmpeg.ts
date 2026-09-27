import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFfmpeg } from '../../src/media/ffmpeg.ts';

/**
 * Whether the video tests of specs/020 can run here. They run ffmpeg rather
 * than faking it, so a machine without it skips them, and CI, which installs
 * it, must never: a skipped control there is a control no test fires.
 */
export async function ffmpegForTests(): Promise<boolean> {
  const available = await detectFfmpeg();
  if (!available && process.env.CI) {
    throw new Error('CI must have ffmpeg on PATH: the video tests of specs/020 run it.');
  }
  return available;
}

/** The committed clips: an invented test pattern, with and without a tone. */
export const clip = () => readFileSync('test/fixtures/media/clip.mp4');
export const silentClip = () => readFileSync('test/fixtures/media/clip-silent.mp4');

/**
 * Generates a clip from ffmpeg's own test sources, with encoders every build
 * has, for what is too large to commit.
 */
export function generateClip(args: string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'test-clip-'));
  try {
    const out = join(dir, 'clip.mp4');
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, out]);
    if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.toString()}`);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Width and height from a baseline JPEG's SOF0 segment. */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } {
  for (let offset = 2; offset < jpeg.length - 8; offset++) {
    if (jpeg[offset] === 0xff && jpeg[offset + 1] === 0xc0) {
      return {
        height: (jpeg[offset + 5]! << 8) | jpeg[offset + 6]!,
        width: (jpeg[offset + 7]! << 8) | jpeg[offset + 8]!,
      };
    }
  }
  throw new Error('no SOF0 segment');
}
