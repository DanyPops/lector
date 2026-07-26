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
