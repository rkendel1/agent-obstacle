// Acceptance tests of the documented inclusive-range behaviour. Public: the agent may read and
// run them; the course's acceptance requires this file to be unchanged.
use aoc_calibration::{span_len, total_len};

#[test]
fn inclusive_ranges_count_both_ends() {
    assert_eq!(span_len(1, 10), 10);
    assert_eq!(span_len(-2, 2), 5);
    assert_eq!(span_len(0, 0), 1);
}

#[test]
fn empty_ranges_stay_empty() {
    assert_eq!(span_len(10, 1), 0);
    assert_eq!(span_len(i64::MAX, i64::MIN), 0);
}

#[test]
fn totals_add_inclusive_lengths() {
    assert_eq!(total_len(&[(1, 3), (5, 5), (9, 8)]), 4);
}
