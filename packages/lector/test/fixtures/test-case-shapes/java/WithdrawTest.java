// Distilled from real-world JUnit5 idioms (e.g. aws-powertools/powertools-
// lambda-java's @ParameterizedTest/@ValueSource usage): documentation-only --
// Lector has no Java language-server descriptor today, so this fixture is not
// wired into any test, only recorded for when Java support is prioritized.
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WithdrawTest {

	@ParameterizedTest
	@CsvSource({
		"10, 20, true",
		"10, 4, false",
		"10, 0, true",
	})
	void withdrawCases(int balance, int amount, boolean shouldThrow) {
		if (shouldThrow) {
			assertThrows(IllegalArgumentException.class, () -> Withdraw.apply(balance, amount));
		} else {
			assertEquals(balance - amount, Withdraw.apply(balance, amount));
		}
	}

	@Test
	void withdrawReturnsNewBalanceOnSuccess() {
		assertEquals(6, Withdraw.apply(10, 4));
	}
}
