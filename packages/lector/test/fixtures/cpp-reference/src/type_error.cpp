#include "contracts/payment.h"

contracts::Order BadAmount() {
	contracts::Order order;
	order.amount = "not-a-number";
	return order;
}
