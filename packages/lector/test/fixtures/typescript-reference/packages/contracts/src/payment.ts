export interface Order {
	readonly id: string;
	readonly amountCents: number;
}

export interface Receipt {
	readonly transactionId: string;
}

export interface PaymentProcessor {
	process(order: Order): Promise<Receipt>;
}

export abstract class BaseProcessor implements PaymentProcessor {
	abstract process(order: Order): Promise<Receipt>;

	protected reference(order: Order): string {
		return `${order.id}:${order.amountCents}`;
	}
}

export function describeOrder(order: Order): string;
export function describeOrder(orderId: string): string;
export function describeOrder(value: Order | string): string {
	return typeof value === "string" ? value : `${value.id}:${value.amountCents}`;
}
