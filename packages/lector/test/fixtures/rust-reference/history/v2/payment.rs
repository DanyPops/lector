#[derive(Clone)]
pub struct PurchaseOrder {
    pub amount: i64,
    pub currency: String,
}

pub struct Receipt {
    pub order: PurchaseOrder,
    pub processed: bool,
}

pub trait PaymentProcessor {
    fn process(&self, order: PurchaseOrder) -> Receipt;
}
