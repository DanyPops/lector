#[derive(Clone)]
pub struct Order {
    pub amount: i64,
}

pub struct Receipt {
    pub order: Order,
    pub processed: bool,
}

pub trait PaymentProcessor {
    fn process(&self, order: Order) -> Receipt;
}
