import type { UserRole } from '../models/User';
import type { TicketStatus } from '../models/Ticket';

export interface AgentHistorySignals {
  requestMessages: boolean;
  privateMessages: boolean;
  legacyComments: boolean;
  assignmentsOrProposals: boolean;
  completionCredit: boolean;
}

export function hasAgentHistory(history: AgentHistorySignals): boolean {
  return Object.values(history).some(Boolean);
}

export function canSetTicketStatusDirectly(role: UserRole, status?: TicketStatus): boolean {
  if (!status) return true;
  if (role === 'client' || status === 'Ready for review' || status === 'Resolved') return false;
  return true;
}

export function canChangeAssignee(role: UserRole, requestStatus: TicketStatus): boolean {
  return role === 'admin' && requestStatus !== 'Ready for review';
}

export function returnReopenedWorkToQueue(assignedAgentAvailable: boolean): boolean {
  return !assignedAgentAvailable;
}
