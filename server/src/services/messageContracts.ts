import { z } from 'zod';
import { attachmentInputSchema } from './attachmentValidation';

const messageTextSchema = z.string().trim().max(20000).default('').refine(
  value => value.split(/\s+/).filter(Boolean).length <= 2000,
  'Messages can contain at most 2,000 words.',
);

function nonEmptyMessage(value: { message: string; attachment?: unknown; attachments?: unknown[] }): boolean {
  return Boolean(value.message || value.attachment || value.attachments?.length);
}

function withinMessageAttachmentLimit(value: { attachment?: { size: number }; attachments?: Array<{ size: number }> }): boolean {
  return [value.attachment, ...(value.attachments || [])].filter(Boolean).reduce((total, item) => total + (item?.size || 0), 0) <= 5 * 1024 * 1024;
}

const commonMessageFields = {
  message: messageTextSchema,
  attachment: attachmentInputSchema.optional(),
  attachments: z.array(attachmentInputSchema).max(10).optional(),
};

export const directMessageInputSchema = z.object({
  ...commonMessageFields,
  submissionId: z.string().uuid().optional(),
}).refine(nonEmptyMessage, 'Write a message or add an attachment.').refine(withinMessageAttachmentLimit, 'Attachments together must be 5 MB or smaller.');

export const threadMessageInputSchema = z.object({
  ...commonMessageFields,
  submissionId: z.string().uuid().optional(),
}).refine(nonEmptyMessage, 'Write a message or add an attachment.').refine(withinMessageAttachmentLimit, 'Attachments together must be 5 MB or smaller.');

export const workReviewSubmissionSchema = z.object({
  message: z.string().trim().min(10, 'Add a delivery note of at least 10 characters.').max(2000),
  attachment: attachmentInputSchema.optional(),
  attachments: z.array(attachmentInputSchema).max(10).optional(),
  submissionId: z.string().uuid(),
}).refine(withinMessageAttachmentLimit, 'Attachments together must be 5 MB or smaller.');
