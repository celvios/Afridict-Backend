import { integer, MAX_UINT256 } from '../financial/model.js';

export const PRICE_SCALE = 1_000_000n;

export type OrderSide = 'buy' | 'sell';

export interface RestingOrder {
  id: string;
  side: OrderSide;
  price: bigint;
  remaining: bigint;
  sequence: bigint;
}

export interface Match {
  makerId: string;
  quantity: bigint;
  price: bigint;
}

export function parseOrderAmount(value: string, field: string) {
  try {
    const amount = integer(value);
    if (amount === 0n) throw new Error(`${field} must be positive`);
    return amount;
  } catch {
    throw new Error(`${field} must be a positive canonical integer`);
  }
}

export function parsePrice(value: string) {
  const price = parseOrderAmount(value, 'price');
  if (price >= PRICE_SCALE) throw new Error('price must be below the price scale');
  return price;
}

const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

/**
 * Splits one fully collateralized payout across the two counterparties.
 * The buyer funds the selected-outcome claim and the seller funds its complement.
 */
export function contractCollateral(quantity: bigint, price: bigint,contractUnit:bigint=PRICE_SCALE) {
  if (quantity<=0n||price<=0n||price>=PRICE_SCALE||contractUnit<=1n)throw new Error('Invalid contract collateral');
  if(quantity>MAX_UINT256/contractUnit||contractUnit>MAX_UINT256/price)throw new Error('Contract collateral exceeds uint256');
  const buyerPerShare=contractUnit*price/PRICE_SCALE;
  if(buyerPerShare<=0n||buyerPerShare>=contractUnit)throw new Error('Price is below the collateral asset precision');
  const buyer=quantity*buyerPerShare,seller=quantity*(contractUnit-buyerPerShare);
  return {buyer,seller,total:quantity*contractUnit};
}

export function executionFee(side: OrderSide, quantity: bigint, price: bigint, feeBps: bigint,contractUnit:bigint=PRICE_SCALE) {
  if (quantity <= 0n || price <= 0n || price >= PRICE_SCALE || feeBps < 0n || feeBps > 1000n) throw new Error('Invalid execution fee');
  const split=contractCollateral(1n,price,contractUnit),perShare=side==='buy'?split.buyer:split.seller;
  if (quantity > MAX_UINT256 / contractUnit) throw new Error('Execution fee exceeds uint256');
  return quantity * ceilDiv(perShare * feeBps, 10_000n);
}

export function reservationRequired(side: OrderSide, quantity: bigint, limitPrice: bigint, feeBps: bigint,contractUnit:bigint=PRICE_SCALE) {
  const collateral = contractCollateral(quantity,limitPrice,contractUnit)[side==='buy'?'buyer':'seller'];
  const fee=executionFee(side,quantity,limitPrice,feeBps,contractUnit);
  if (collateral + fee > MAX_UINT256) throw new Error('Reservation exceeds uint256');
  return { collateral, fee, total: collateral + fee };
}

export function crosses(incomingSide: OrderSide, incomingPrice: bigint, makerPrice: bigint) {
  return incomingSide === 'buy' ? incomingPrice >= makerPrice : incomingPrice <= makerPrice;
}

/** Pure reference matcher. Input order is ignored; maker sequence is authoritative. */
export function matchPriceTime(side: OrderSide, limitPrice: bigint, quantity: bigint, resting: RestingOrder[]) {
  if (quantity <= 0n) throw new Error('Quantity must be positive');
  const makers = resting.filter(order => order.side !== side && order.remaining > 0n && crosses(side, limitPrice, order.price))
    .sort((a, b) => {
      if (a.price !== b.price) {
        const priceOrder = a.price < b.price ? -1 : 1;
        return side === 'buy' ? priceOrder : -priceOrder;
      }
      return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.id.localeCompare(b.id);
    });
  const matches: Match[] = [];
  let remaining = quantity;
  for (const maker of makers) {
    if (remaining === 0n) break;
    const filled = remaining < maker.remaining ? remaining : maker.remaining;
    matches.push({ makerId: maker.id, quantity: filled, price: maker.price });
    remaining -= filled;
  }
  return { matches, remaining };
}
