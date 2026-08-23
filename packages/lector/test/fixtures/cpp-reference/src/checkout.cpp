#include "app/checkout.h"

#include "app/templates.h"

namespace app {

contracts::Receipt RunCheckout(contracts::PaymentProcessor& processor, const contracts::Order& order) {
	int amount = MaxValue(order.amount, 0);
	contracts::Order normalized{amount};
	return processor.Process(normalized);
}

contracts::Receipt RunCheckoutTwice(contracts::PaymentProcessor& processor, const contracts::Order& order) {
	RunCheckout(processor, order);
	return RunCheckout(processor, order);
}

}  // namespace app
