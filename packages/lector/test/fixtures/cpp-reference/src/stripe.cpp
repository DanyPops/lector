#include "app/stripe.h"

namespace app {

contracts::Receipt StripeProcessor::Process(const contracts::Order& order) {
	return contracts::Receipt{order, true};
}

contracts::PaymentProcessor* CreateProcessor() {
	return new StripeProcessor();
}

}  // namespace app
