import { Ticket } from '../models/Ticket';
import { trackEvent } from './events';

/** Return unfinished assigned requests to the queue before an agent is disabled or removed. */
export async function releaseActiveWorkForUser(userId: string, actor: { id: string; name: string }, userName: string): Promise<void> {
  const tickets = await Ticket.find({
    assignedTo: userId,
    status: { $in: ['Open', 'In Progress'] },
  }).select('_id clientId title status');

  for (const ticket of tickets) {
    const previousStatus = ticket.status;
    const result = await Ticket.updateOne(
      { _id: ticket._id, assignedTo: userId, status: previousStatus },
      {
        $set: { assignedTo: null, ...(previousStatus === 'In Progress' ? { status: 'Open' } : {}) },
        $pull: { proposals: { agent: userId } },
      },
    );
    if (!result.modifiedCount) continue;

    await trackEvent({
      actorId: actor.id,
      participantIds: [ticket.clientId.toString()],
      action: previousStatus === 'In Progress' ? 'status_changed' : 'assignee_changed',
      summary: `${actor.name} returned “${ticket.title}” to the agency queue after ${userName}'s account was disabled`,
      ticketId: ticket._id,
      details: { previousStatus, status: 'Open', previousAssignee: userId, assignee: null },
      notification: {
        type: previousStatus === 'In Progress' ? 'status_changed' : 'assignee_changed',
        title: 'Request returned to the agency queue',
        message: `“${ticket.title}” is available for another agent.`,
        recipientIds: [ticket.clientId.toString()],
        link: `/requests/${ticket.id}`,
      },
    });
  }
}
