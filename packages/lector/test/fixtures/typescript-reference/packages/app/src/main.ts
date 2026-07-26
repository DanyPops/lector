import { runCheckoutTwice } from "./checkout.ts";
import { StripeProcessor } from "./stripe.ts";

export async function main(): Promise<void> {
	const processor = new StripeProcessor();
	await runCheckoutTwice(processor, { id: "order-1", amountCents: 4200 });
}
