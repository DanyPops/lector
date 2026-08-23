use contracts::{Order, PaymentProcessor, Receipt};

pub struct StripeProcessor;

impl PaymentProcessor for StripeProcessor {
    fn process(&self, order: Order) -> Receipt {
        Receipt { order, processed: true }
    }
}

pub fn create_processor() -> impl PaymentProcessor {
    StripeProcessor
}
