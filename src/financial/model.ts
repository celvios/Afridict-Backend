// Executable reference mathematics. These functions do not post funds or
// approve the custody or payout policy; those decisions require specialist review.
export const MAX_UINT256 = (1n << 256n) - 1n;
export function integer(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Expected an unsigned canonical integer string');
  const n = BigInt(value);
  if (n > MAX_UINT256) throw new Error('Value exceeds uint256');
  return n;
}
export function reserveCost(quantity: bigint, price: bigint, scale: bigint, feeBps: bigint) {
  if (quantity < 0n || price < 0n || scale <= 0n || price > scale || feeBps < 0n || feeBps > 10000n)
    throw new Error('Invalid reservation inputs');
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const notional = ceil(quantity * price, scale);
  const fee = ceil(notional * feeBps, 10000n);
  if (notional + fee > MAX_UINT256) throw new Error('Reservation exceeds uint256');
  return { notional, fee, total: notional + fee };
}
export interface Posting { asset: string; account: string; debit: bigint; credit: bigint }
export function validateJournal(postings: Posting[]) {
  if (postings.length < 2) throw new Error('A journal requires at least two postings');
  const totals = new Map<string, bigint>();
  for (const p of postings) {
    if (!p.asset || !p.account || p.debit < 0n || p.credit < 0n ||
      (p.debit === 0n) === (p.credit === 0n)) throw new Error('Invalid posting');
    totals.set(p.asset, (totals.get(p.asset) ?? 0n) + p.debit - p.credit);
  }
  if ([...totals.values()].some(n => n !== 0n)) throw new Error('Journal must balance per asset');
}
export function scalarVector(observed: bigint, lower: bigint, upper: bigint) {
  if (upper <= lower) throw new Error('Invalid scalar range');
  const bounded = observed < lower ? lower : observed > upper ? upper : observed;
  return { denominator: upper - lower, weights: [upper - bounded, bounded - lower] };
}
export function redemption(quantity: bigint, weight: bigint, denominator: bigint) {
  if (quantity < 0n || denominator <= 0n || weight < 0n || weight > denominator) throw new Error('Invalid payout');
  const numerator = quantity * weight;
  return { payout: numerator / denominator, remainder: numerator % denominator };
}

export const reservationTransitions = {
  held: ['partially_consumed', 'consumed', 'release_pending'],
  partially_consumed: ['partially_consumed', 'consumed', 'release_pending'],
  release_pending: ['released'], consumed: [], released: [],
} as const;
export const settlementTransitions = {
  prepared: ['submitted', 'abandoned'], submitted: ['observed', 'uncertain', 'reverted'],
  observed: ['finalized', 'uncertain'], uncertain: ['submitted', 'observed', 'reverted'],
  reverted: ['prepared', 'abandoned'], finalized: [], abandoned: [],
} as const;
