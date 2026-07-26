import type { Order, PaymentProcessor, Receipt } from "@fixture/contracts";

export class StripeProcessor implements PaymentProcessor {
	async process(order: Order): Promise<Receipt> {
		return Promise.resolve({ transactionId: `stripe:${order.id}:${order.amountCents}` });
	}
}

export interface ProcessorFactory {
	create(): PaymentProcessor;
}

export class StripeProcessorFactory implements ProcessorFactory {
	create(): StripeProcessor {
		return new StripeProcessor();
	}
}
