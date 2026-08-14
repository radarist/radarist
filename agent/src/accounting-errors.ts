/**
 * @file accounting-errors.ts
 * @description TEST-021 — typed failure for token accounting that cannot be
 * priced from the canonical rate card.
 *
 * The rate-card estimators MUST fail closed rather than substitute a different
 * model's price (or a silent zero) when the effective model is unknown or a
 * time-bounded (introductory) rate has expired / lacks a receipt timestamp.
 * Callers catch this typed error and record the cost as unavailable — never as
 * zero and never at a wrong-model rate.
 */
export class AccountingUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'AccountingUnavailableError';
  }
}
