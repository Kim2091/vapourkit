/**
 * Type-safe error handling utilities
 */

export interface AppError {
  message: string;
  code?: string;
  details?: unknown;
}

export const isError = (error: unknown): error is Error => {
  return error instanceof Error;
};

export const getErrorMessage = (error: unknown): string => {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
};

export const createAppError = (error: unknown): AppError => {
  return {
    message: getErrorMessage(error),
    details: error,
  };
};
