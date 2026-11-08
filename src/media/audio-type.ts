/**
 * The media type of audio bytes, read from their first bytes, as the AI SDK's
 * `transcribe` read it before uploading (specs/053 § Transcription is a port
 * the registry implements with the provider's SDK): its signature table, an
 * ID3 tag skipped, and `audio/wav` when nothing matches. The file the
 * transcription API receives is therefore named and typed as it was.
 */

const SIGNATURES: readonly { mediaType: string; prefix: readonly (number | null)[] }[] = [
  { mediaType: 'audio/aac', prefix: [0xff, 0xf0] },
  { mediaType: 'audio/aac', prefix: [0xff, 0xf1] },
  { mediaType: 'audio/aac', prefix: [0xff, 0xf8] },
  { mediaType: 'audio/aac', prefix: [0xff, 0xf9] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xfb] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xfa] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xf3] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xf2] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xe3] },
  { mediaType: 'audio/mpeg', prefix: [0xff, 0xe2] },
  {
    mediaType: 'audio/wav',
    prefix: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45],
  },
  { mediaType: 'audio/ogg', prefix: [0x4f, 0x67, 0x67, 0x53] },
  { mediaType: 'audio/flac', prefix: [0x66, 0x4c, 0x61, 0x43] },
  { mediaType: 'audio/aac', prefix: [0x40, 0x15, 0x00, 0x00] },
  { mediaType: 'audio/webm', prefix: [0x1a, 0x45, 0xdf, 0xa3] },
  { mediaType: 'audio/mp4', prefix: [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70] },
];

const SNIFF_BYTES = 18;
const ID3_SCAN_BYTES = 131_084;

function hasId3(bytes: Uint8Array): boolean {
  return bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function withoutId3(bytes: Uint8Array): Uint8Array {
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  return bytes.subarray(size + 10);
}

export function audioMediaType(audio: Uint8Array): string {
  let bytes = audio.subarray(0, SNIFF_BYTES);
  if (hasId3(bytes)) bytes = withoutId3(audio.subarray(0, ID3_SCAN_BYTES));
  for (const { mediaType, prefix } of SIGNATURES) {
    if (
      bytes.length >= prefix.length &&
      prefix.every((byte, index) => byte === null || bytes[index] === byte)
    ) {
      return mediaType;
    }
  }
  return 'audio/wav';
}

/** The file extension the upload is named with, as the AI SDK named it. */
export function audioExtension(mediaType: string): string {
  const subtype = mediaType.toLowerCase().split('/')[1] ?? '';
  const known: Record<string, string> = {
    mpeg: 'mp3',
    'x-wav': 'wav',
    opus: 'ogg',
    mp4: 'm4a',
    'x-m4a': 'm4a',
  };
  return known[subtype] ?? subtype;
}
