import type { NextFunction, Request, Response } from 'express';
export function notFound(_req: Request, res: Response): void { res.status(404).json({ success: false, message: 'Route not found.' }); }
export function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction): void {
  const candidate = error as Error & { status?: number; statusCode?: number };
  const status = candidate.statusCode ?? candidate.status;
  if (status === 400 || status === 413) {
    res.status(status).json({ success: false, message: status === 413 ? 'The request body is too large.' : 'The request body is invalid.' });
    return;
  }
  console.error(error);
  res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
}
