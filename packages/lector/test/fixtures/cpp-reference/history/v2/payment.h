#pragma once

namespace contracts {

struct PurchaseOrder {
	int amount;
	const char* currency;
};

struct Receipt {
	PurchaseOrder order;
	bool processed;
};

class PaymentProcessor {
public:
	virtual ~PaymentProcessor() = default;
	virtual Receipt Process(const PurchaseOrder& order) = 0;
};

}  // namespace contracts
