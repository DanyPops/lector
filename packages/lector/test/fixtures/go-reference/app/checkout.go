package app

import "fixture.lector.invalid/gomod-reference/contracts"

func RunCheckout(processor contracts.PaymentProcessor, order contracts.Order) (contracts.Receipt, error) {
	return processor.Process(order)
}

func RunCheckoutTwice(processor contracts.PaymentProcessor, order contracts.Order) (contracts.Receipt, error) {
	if _, err := RunCheckout(processor, order); err != nil {
		return contracts.Receipt{}, err
	}
	return RunCheckout(processor, order)
}
