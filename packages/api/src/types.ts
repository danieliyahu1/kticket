export type ErrorType =
  | "invalid"
  | "conflict"
  | "policy"
  | "network"
  | "upstream"
  | "unauthorized"
  | `unknown-${string}`;

export interface ErrorEnvelope {
  error: {
    type: ErrorType;
    message: string;
    retryable: boolean;
    retryAfter?: number;
    detail?: unknown;
  };
}
