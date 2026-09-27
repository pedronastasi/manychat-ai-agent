import { describe, it, expect } from 'vitest';
import { detectFfmpeg, FfmpegVideoSplitter } from '../../src/media/ffmpeg.ts';
import { MediaFailure } from '../../src/media/port.ts';
import { clip, ffmpegForTests, generateClip, jpegSize, silentClip } from '../helpers/ffmpeg.ts';

/**
 * specs/020 § A video is read as still frames and a transcript of its
 * soundtrack. ffmpeg is run, not faked: what is under test is how it treats
 * the bytes.
 */

const available = await ffmpegForTests();
const both = { frames: true, soundtrack: true };
const signal = () => AbortSignal.timeout(30_000);

describe('specs/020 § A server without ffmpeg sends every video to the fallback', () => {
  it('is detected at boot, not on the first video', async () => {
    expect(
      await detectFfmpeg({ ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' }),
    ).toBe(false);
  });
});

describe.skipIf(!available)('specs/020 § A video is read as still frames and a soundtrack', () => {
  const splitter = new FfmpegVideoSplitter();

  it('takes 4 frames and the soundtrack from the committed clip', async () => {
    const parts = await splitter.split(clip(), both, signal());
    expect(parts.frames).toHaveLength(4);
    for (const frame of parts.frames) {
      expect(frame.mediaType).toBe('image/jpeg');
      expect([...frame.data.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    }
    // Four distinct moments, not one frame repeated.
    expect(new Set(parts.frames.map(frame => Buffer.from(frame.data).toString('hex'))).size).toBe(
      4,
    );
    // Ogg, the format a voice note already arrives in.
    expect(Buffer.from(parts.soundtrack!.subarray(0, 4)).toString()).toBe('OggS');
  });

  it('never takes more than 4 frames, however long the video', async () => {
    const long = generateClip([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=10:duration=20',
      '-c:v',
      'mpeg4',
    ]);
    expect((await splitter.split(long, both, signal())).frames).toHaveLength(4);
  });

  it('scales frames so the longest side is at most 768 pixels, keeping the aspect', async () => {
    const wide = generateClip([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=5:duration=1',
      '-c:v',
      'mpeg4',
    ]);
    const { frames } = await splitter.split(wide, both, signal());
    expect(jpegSize(frames[0]!.data)).toEqual({ width: 768, height: 432 });
  });

  it('never enlarges a small video', async () => {
    const { frames } = await splitter.split(clip(), both, signal());
    expect(jpegSize(frames[0]!.data)).toEqual({ width: 160, height: 120 });
  });

  it('returns no soundtrack for a clip with no audio track', async () => {
    const parts = await splitter.split(silentClip(), both, signal());
    expect(parts.frames.length).toBeGreaterThan(0);
    expect(parts.soundtrack).toBeNull();
  });

  it('extracts only what the turn can use', async () => {
    const soundOnly = await splitter.split(clip(), { frames: false, soundtrack: true }, signal());
    expect(soundOnly.frames).toEqual([]);
    expect(soundOnly.soundtrack).not.toBeNull();

    const framesOnly = await splitter.split(clip(), { frames: true, soundtrack: false }, signal());
    expect(framesOnly.frames).toHaveLength(4);
    expect(framesOnly.soundtrack).toBeNull();
  });

  it('splits a large MP4 whose index follows its data', async () => {
    // The reason the input is a file, not a pipe: measured 2026-09-27, a 9 MB
    // clip like this one failed from a pipe once it outgrew ffmpeg's buffer.
    const large = generateClip([
      '-f',
      'lavfi',
      '-i',
      'nullsrc=s=640x480:r=25:d=6,geq=random(1)*255:128:128',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'mpeg4',
      '-q:v',
      '1',
      '-c:a',
      'aac',
      '-shortest',
    ]);
    expect(large.length).toBeGreaterThan(2 * 1024 * 1024);
    const moov = large.indexOf('moov');
    const mdat = large.indexOf('mdat');
    expect(moov).toBeGreaterThan(mdat);

    const parts = await splitter.split(large, both, signal());
    expect(parts.frames).toHaveLength(4);
    expect(parts.soundtrack).not.toBeNull();
  });

  it('fails as ffmpeg on a file it cannot parse', async () => {
    const corrupt = Buffer.concat([clip().subarray(0, 64), Buffer.alloc(4096, 0x5a)]);
    await expect(splitter.split(corrupt, both, signal())).rejects.toMatchObject({
      name: 'MediaFailure',
      reason: 'ffmpeg',
    });
  });

  it('parses nothing but an MP4 or 3GP container, whatever else ffmpeg could open', async () => {
    // Left to probe, ffmpeg reads this AVI without complaint; forcing the
    // demuxer is what keeps a playlist or a script dressed as a video from
    // being followed.
    const avi = generateClip([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=5:duration=1',
      '-c:v',
      'mpeg4',
      '-f',
      'avi',
    ]);
    await expect(splitter.split(avi, both, signal())).rejects.toBeInstanceOf(MediaFailure);
  });

  it('is killed by the turn abort signal', async () => {
    const abort = new AbortController();
    const pending = splitter.split(clip(), both, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'ffmpeg' });
  });
});
