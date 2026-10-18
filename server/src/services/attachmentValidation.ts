import { z } from 'zod';
import type { IMessageAttachment } from '../models/ThreadMessage';

export const attachmentInputSchema = z.object({
  kind: z.enum(['image', 'audio', 'file']), name: z.string().trim().min(1).max(120), mimeType: z.string().min(1).max(80),
  // 5 MiB binary becomes about 6.67 MiB as base64. Keep a small margin for the data URL prefix.
  size: z.number().int().positive(), dataUrl: z.string().min(30).max(7_100_000),
});

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function validateAttachment(attachment: IMessageAttachment): string | null {
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const audioTypes = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a'];
  const fileTypes = ['application/pdf', 'text/plain', 'text/csv', 'application/csv', 'application/rtf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'];
  const allowedTypes = attachment.kind === 'image' ? imageTypes : attachment.kind === 'audio' ? audioTypes : fileTypes;
  if (!allowedTypes.includes(attachment.mimeType)) return 'This image, audio, or document format is not supported.';
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.dataUrl);
  if (!match || match[1] !== attachment.mimeType) return 'The attachment data is invalid.';
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length !== attachment.size || bytes.toString('base64') !== match[2]) return 'The attachment data is invalid.';
  const maximum = attachment.kind === 'image' ? MAX_IMAGE_BYTES : attachment.kind === 'audio' ? MAX_AUDIO_BYTES : MAX_FILE_BYTES;
  if (bytes.length > maximum) return attachment.kind === 'image' ? 'Images must be 4 MB or smaller.' : attachment.kind === 'audio' ? 'Voice messages must be 2 MB or smaller.' : 'Files must be 5 MB or smaller.';
  const extension = attachment.name.split('.').pop()?.toLowerCase();
  if (attachment.kind === 'image' && !['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) return 'Use a JPG, PNG, or WebP image.';
  if (attachment.kind === 'audio' && !['webm', 'ogg', 'mp3', 'wav', 'm4a', 'mp4'].includes(extension || '')) return 'Use a WebM, OGG, MP3, WAV, or M4A audio file.';
  if (attachment.kind === 'file' && !['pdf', 'txt', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip'].includes(extension || '')) return 'Attach a PDF, text, CSV, Word, Excel, PowerPoint, or ZIP file.';
  const extensionsByMime: Record<string, string[]> = {
    'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'],
    'audio/webm': ['webm'], 'audio/ogg': ['ogg'], 'audio/mpeg': ['mp3'], 'audio/wav': ['wav'], 'audio/mp4': ['mp4', 'm4a'], 'audio/x-m4a': ['m4a'],
    'application/pdf': ['pdf'], 'text/plain': ['txt'], 'text/csv': ['csv'], 'application/csv': ['csv'], 'application/rtf': ['rtf'],
    'application/msword': ['doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.ms-excel': ['xls'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.ms-powerpoint': ['ppt'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'], 'application/zip': ['zip'],
  };
  if (!extensionsByMime[attachment.mimeType]?.includes(extension || '')) return 'The file extension does not match its selected format.';
  if (!matchesFileSignature(attachment.kind, attachment.mimeType, bytes)) return 'The file contents do not match the selected format.';
  return null;
}

function matchesFileSignature(kind: IMessageAttachment['kind'], mimeType: string, bytes: Buffer): boolean {
  if (kind === 'image') {
    if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (kind === 'audio') {
    if (mimeType === 'audio/ogg') return bytes.subarray(0, 4).toString('ascii') === 'OggS';
    if (mimeType === 'audio/wav') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
    if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
    if (mimeType === 'audio/mpeg') return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/rtf') return bytes.subarray(0, 5).toString('ascii') === '{\\rtf';
  if (['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mimeType)) return bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
  if (['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(mimeType)) return bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'application/csv') return !bytes.includes(0);
  return false;
}
