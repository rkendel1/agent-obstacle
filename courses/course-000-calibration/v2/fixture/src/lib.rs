//! Inclusive integer ranges.
//!
//! `span_len(start, end)` returns how many integers lie in the inclusive range
//! `start..=end`. An empty range (`end < start`) has length 0.

/// Number of integers in the inclusive range `start..=end` (0 when `end < start`).
pub fn span_len(start: i64, end: i64) -> u64 {
    if end < start {
        return 0;
    }
    (end - start) as u64
}

/// Sum of the lengths of several inclusive ranges.
pub fn total_len(spans: &[(i64, i64)]) -> u64 {
    spans.iter().map(|&(s, e)| span_len(s, e)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_point_range_has_one_element() {
        assert_eq!(span_len(5, 5), 1);
    }

    #[test]
    fn empty_range_has_no_elements() {
        assert_eq!(span_len(3, 2), 0);
    }
}
