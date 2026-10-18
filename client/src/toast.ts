export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface ToastPayload {
  kind: ToastKind;
  title: string;
  message: string;
  duration?: number;
}

/** Publish application feedback to the global toast viewport. */
export function showToast(kind: ToastKind, message: string, title?: string, duration = 4200): void {
  const defaultTitles: Record<ToastKind, string> = {
    success: 'Success',
    error: 'Something went wrong',
    warning: 'Attention needed',
    info: 'Update',
  };
  window.dispatchEvent(new CustomEvent<ToastPayload>('catalysthub:toast', {
    detail: { kind, title: title || defaultTitles[kind], message, duration },
  }));
}
