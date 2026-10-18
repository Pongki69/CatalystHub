import type { Role } from './types';

type RoleBadgeProps = {
  role?: Role | 'system' | string | null;
  className?: string;
};

const roles: Role[] = ['client', 'admin', 'agent'];

/** Shared role label. Unknown/missing roles stay neutral instead of guessing. */
export default function RoleBadge({ role, className = '' }: RoleBadgeProps) {
  const normalized = typeof role === 'string' ? role.toLowerCase() : '';
  const verifiedRole = roles.find(value => value === normalized);
  const key = normalized === 'system' ? 'system' : verifiedRole || 'unknown';
  const label = key === 'unknown' ? 'UNKNOWN' : key.toUpperCase();

  return <span className={`role-badge ${className}`} data-role={key}>{label}</span>;
}
