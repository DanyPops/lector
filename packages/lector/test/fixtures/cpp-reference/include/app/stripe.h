#pragma once

#include "contracts/payment.h"

namespace app {

class StripeProcessor : public contracts::PaymentProcessor {
public:
	contracts::Receipt Process(const contracts::Order& order) override;
};

contracts::PaymentProcessor* CreateProcessor();

}  // namespace app
