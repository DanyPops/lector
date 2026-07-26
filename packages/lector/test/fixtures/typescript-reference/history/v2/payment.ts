export interface PurchaseOrder {
	readonly id: string;
	readonly amountCents: number;
	readonly currency: "USD" | "EUR";
}

export interface Receipt {
	readonly transactionId: string;
}

export interface PaymentProcessor {
	process(order: PurchaseOrder): Promise<Receipt>;
}
