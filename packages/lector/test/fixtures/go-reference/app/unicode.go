package app

func 指南针() string {
	return "north"
}

func describeCompass() string {
	return 指南针()
}

func summarizeCompass() string {
	return "heading: " + describeCompass()
}
