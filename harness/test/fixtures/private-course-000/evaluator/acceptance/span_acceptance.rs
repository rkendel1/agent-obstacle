// Hidden acceptance test for course-000-calibration v1. Evaluator-only: never copied
// into the agent's workspace; the evaluator copies it into tests/ of a fresh copy.
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
