macro_rules! greet {
    ($name:expr) => {
        format!("hello, {}", $name)
    };
}

pub fn greet_fixture() -> String {
    greet!("fixture")
}
