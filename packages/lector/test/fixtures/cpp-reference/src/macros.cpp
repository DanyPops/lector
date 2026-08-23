#include "app/macros.h"

#define GREETING "hello"

const char* GreetFixture() {
	return GREETING;
}

#ifdef FIXTURE_FEATURE
int ExtraFeatureValue() {
	return 42;
}
#endif
