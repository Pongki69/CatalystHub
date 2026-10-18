import type { UserRole } from '../models/User';

export function activityActorProjection(role: UserRole): string {
  return role === 'admin' ? 'name email role' : 'name role';
}
