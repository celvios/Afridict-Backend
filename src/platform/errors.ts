export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function requireCondition(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
