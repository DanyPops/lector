#pragma once

namespace contracts {

struct Order {
	int amount;
};

struct Receipt {
	Order order;
	bool processed;
};

class PaymentProcessor {
public:
	virtual ~PaymentProcessor() = default;
	virtual Receipt Process(const Order& order) = 0;
};

}  // namespace contracts
