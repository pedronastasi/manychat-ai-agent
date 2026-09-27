import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaFailure, type MediaImage, type VideoParts, type VideoSplitter } from './port.ts';

/**
 * Neither number was measured (specs/020 § A video is read as still frames).
 * They hold a video's cost near that of four images, whatever its length.
 */
const MAX_FRAMES = 4;
const MAX_SIDE = 768;

/** The binaries, overridable so a test can name one that does not exist. */
export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

const DEFAULT_PATHS: FfmpegPaths = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

/**
 * Everything ffmpeg is given before its input. The file is untrusted input to
 * a media parser (specs/020), so:
 *
 * - `-f mov` forces the MP4/3GP demuxer. Left to probe, ffmpeg would honour a
 *   playlist disguised as a video and open whatever it lists.
 * - `-protocol_whitelist file` leaves no network protocol to open.
 *
 * The input is a file rather than a pipe, deliberately: an MP4 whose index
 * (`moov`) comes after its data cannot be read from a pipe once it outgrows
 * ffmpeg's buffer. Measured 2026-09-27: a 9 MB clip failed from a pipe with
 * "Invalid data found when processing input" and split cleanly from a file.
 */
const INPUT_FLAGS = ['-protocol_whitelist', 'file', '-f', 'mov'];

function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

/**
 * Whether both binaries run. Checked once at boot; a server without them sends
 * every video to the media fallback.
 */
export async function detectFfmpeg(paths: FfmpegPaths = DEFAULT_PATHS): Promise<boolean> {
  try {
    await run(paths.ffmpeg, ['-version'], AbortSignal.timeout(5000));
    await run(paths.ffprobe, ['-version'], AbortSignal.timeout(5000));
    return true;
  } catch {
    return false;
  }
}

interface Probe {
  duration: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

function parseProbe(json: string): Probe {
  const parsed = JSON.parse(json) as {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  const types = new Set((parsed.streams ?? []).map(stream => stream.codec_type));
  const duration = Number(parsed.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    hasVideo: types.has('video'),
    hasAudio: types.has('audio'),
  };
}

/** Longest side at most MAX_SIDE, never upscaled. Quoted for the filter parser. */
const SCALE = `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`;

/**
 * Up to MAX_FRAMES frames, the first at or after the middle of each equal
 * slice of the video, so the opening frame (often a blur while the camera
 * settles) is not one of them. A video of unknown length gives one a second.
 *
 * `select` against the count already taken, not the `fps` filter: `fps` only
 * emits a slot once it has seen a frame past it, so it dropped the last one at
 * the end of every clip tried.
 */
function frameArgs(probe: Probe, pattern: string): string[] {
  const slice = probe.duration === null ? 1 : probe.duration / MAX_FRAMES;
  const first = probe.duration === null ? 0 : slice / 2;
  return [
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `select='gte(t,${first.toFixed(3)}+${slice.toFixed(3)}*selected_n)',${SCALE}`,
    '-fps_mode',
    'vfr',
    '-frames:v',
    `${MAX_FRAMES}`,
    '-q:v',
    '4',
    pattern,
  ];
}

/**
 * Ogg/Opus, mono, 16 kHz: the format a WhatsApp voice note already arrives in,
 * so the transcriber sees one format, and small enough that a 16 MB video's
 * soundtrack stays far under any transcription upload limit.
 */
function soundtrackArgs(path: string): string[] {
  return [
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libopus',
    '-b:a',
    '32k',
    path,
  ];
}

/**
 * Splits a video into still frames and its soundtrack with ffmpeg (specs/020).
 * Nothing reaches the binaries but the bytes, written to a private temporary
 * directory, and fixed arguments. The turn's abort signal kills them.
 */
export class FfmpegVideoSplitter implements VideoSplitter {
  private readonly paths: FfmpegPaths;

  constructor(paths: FfmpegPaths = DEFAULT_PATHS) {
    this.paths = paths;
  }

  async split(
    video: Uint8Array,
    want: { frames: boolean; soundtrack: boolean },
    signal: AbortSignal,
  ): Promise<VideoParts> {
    // mkdtemp creates the directory readable by this user only.
    const dir = await mkdtemp(join(tmpdir(), 'inbound-video-'));
    try {
      const input = join(dir, 'input');
      await writeFile(input, video, { mode: 0o600 });

      const probe = parseProbe(
        await run(
          this.paths.ffprobe,
          [
            '-v',
            'error',
            ...INPUT_FLAGS,
            '-show_entries',
            'format=duration:stream=codec_type',
            '-of',
            'json',
            input,
          ],
          signal,
        ),
      );

      const frames = want.frames && probe.hasVideo;
      const soundtrack = want.soundtrack && probe.hasAudio;
      if (!frames && !soundtrack) return { frames: [], soundtrack: null };

      const soundtrackPath = join(dir, 'soundtrack.ogg');
      await run(
        this.paths.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          ...INPUT_FLAGS,
          '-i',
          input,
          ...(frames ? frameArgs(probe, join(dir, 'frame-%d.jpg')) : []),
          ...(soundtrack ? soundtrackArgs(soundtrackPath) : []),
        ],
        signal,
      );

      return {
        frames: frames ? await readFrames(dir) : [],
        soundtrack: soundtrack ? await readFile(soundtrackPath) : null,
      };
    } catch (error) {
      throw new MediaFailure('ffmpeg', error instanceof Error ? error.message : 'unknown', {
        cause: error,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function readFrames(dir: string): Promise<MediaImage[]> {
  const names = (await readdir(dir))
    .filter(name => /^frame-\d+\.jpg$/.test(name))
    .sort((first, second) => frameNumber(first) - frameNumber(second))
    .slice(0, MAX_FRAMES);
  return Promise.all(
    names.map(async name => ({ data: await readFile(join(dir, name)), mediaType: 'image/jpeg' })),
  );
}

const frameNumber = (name: string) => Number(/\d+/.exec(name)?.[0]);
