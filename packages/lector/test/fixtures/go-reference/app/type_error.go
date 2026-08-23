package app

import "fixture.lector.invalid/gomod-reference/contracts"

func BadAmount() contracts.Order {
	return contracts.Order{Amount: "not-a-number"}
}
