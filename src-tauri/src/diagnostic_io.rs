use std::io::{self, Read};

/// Drains a diagnostic pipe to EOF while retaining only a bounded prefix.
///
/// Stopping the read after the retained limit can close the pipe while the
/// child is still writing, which may turn a healthy diagnostic into a broken-
/// pipe failure. This helper keeps memory bounded without applying backpressure
/// to the child after the retained prefix is full.
pub(crate) fn drain_bounded<R: Read>(mut reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut chunk = [0_u8; 8 * 1024];

    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if retained.len() < limit {
            let remaining = limit - retained.len();
            retained.extend_from_slice(&chunk[..read.min(remaining)]);
        }
    }

    Ok(retained)
}

#[cfg(test)]
mod tests {
    use super::drain_bounded;
    use std::io::Cursor;

    #[test]
    fn retains_only_the_requested_prefix() {
        let input = vec![b'x'; 128 * 1024];
        let output = drain_bounded(Cursor::new(input), 64 * 1024).unwrap();
        assert_eq!(output.len(), 64 * 1024);
        assert!(output.iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn zero_limit_still_drains_without_retaining() {
        let output = drain_bounded(Cursor::new(b"discarded"), 0).unwrap();
        assert!(output.is_empty());
    }
}
