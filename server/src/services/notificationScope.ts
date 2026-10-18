/** Notification records belong to one recipient, including when read by an admin. */
export function notificationRecipientFilter(recipientId: string) {
  return { recipient: recipientId };
}
