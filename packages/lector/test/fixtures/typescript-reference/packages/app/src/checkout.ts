import type { Order, PaymentProcessor, Receipt } from "@fixture/contracts";

export async function runCheckout(processor: PaymentProcessor, order: Order): Promise<Receipt> {
	return processor.process(order);
}

export async function runCheckoutTwice(processor: PaymentProcessor, order: Order): Promise<readonly Receipt[]> {
	return Promise.all([runCheckout(processor, order), runCheckout(processor, order)]);
}
