#pragma once

#include "contracts/payment.h"

namespace app {

contracts::Receipt RunCheckout(contracts::PaymentProcessor& processor, const contracts::Order& order);
contracts::Receipt RunCheckoutTwice(contracts::PaymentProcessor& processor, const contracts::Order& order);

}  // namespace app
