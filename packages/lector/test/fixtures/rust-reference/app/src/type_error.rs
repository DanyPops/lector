use contracts::Order;

pub fn bad_amount() -> Order {
    Order { amount: "not-a-number" }
}
