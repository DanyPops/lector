use contracts::{Order, PaymentProcessor, Receipt};

pub fn run_checkout(processor: &dyn PaymentProcessor, order: Order) -> Receipt {
    processor.process(order)
}

pub fn run_checkout_twice(processor: &dyn PaymentProcessor, order: Order) -> Receipt {
    run_checkout(processor, order.clone());
    run_checkout(processor, order)
}
