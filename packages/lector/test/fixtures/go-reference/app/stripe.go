package app

import "fixture.lector.invalid/gomod-reference/contracts"

type StripeProcessor struct{}

func (StripeProcessor) Process(order contracts.Order) (contracts.Receipt, error) {
	return contracts.Receipt{Order: order, Processed: true}, nil
}

func CreateProcessor() contracts.PaymentProcessor {
	return StripeProcessor{}
}
