pub fn 指南针() -> &'static str {
    "north"
}

pub fn describe_compass() -> &'static str {
    指南针()
}

pub fn summarize_compass() -> String {
    format!("heading: {}", describe_compass())
}
