use std::io::{self, Cursor, Read};
use zstd::stream::read::Decoder;

const ZSTD_MAGIC: u32 = 0xFD2FB528;
const SKIPPABLE_MAGIC_MIN: u32 = 0x184D2A50;
const SKIPPABLE_MAGIC_MAX: u32 = 0x184D2A5F;
const MAX_DECOMPRESSED_FRAME_SIZE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameBoundary {
    Complete { end: usize, skippable: bool },
    Torn,
}

/// Locate one complete frame without confusing Frame Content Size with the
/// compressed byte length. Boundaries come from the block chain and checksum.
fn scan_frame(data: &[u8]) -> io::Result<FrameBoundary> {
    if data.len() < 4 {
        return Ok(FrameBoundary::Torn);
    }
    let magic = u32::from_le_bytes(data[..4].try_into().unwrap());
    if (SKIPPABLE_MAGIC_MIN..=SKIPPABLE_MAGIC_MAX).contains(&magic) {
        if data.len() < 8 {
            return Ok(FrameBoundary::Torn);
        }
        let payload = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
        let end = 8usize.checked_add(payload).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "skippable frame overflow")
        })?;
        return Ok(if end <= data.len() {
            FrameBoundary::Complete {
                end,
                skippable: true,
            }
        } else {
            FrameBoundary::Torn
        });
    }
    if magic != ZSTD_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid zstd frame magic 0x{magic:08X}"),
        ));
    }

    let mut offset = 4usize;
    let Some(&descriptor) = data.get(offset) else {
        return Ok(FrameBoundary::Torn);
    };
    offset += 1;
    if descriptor & 0x18 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reserved zstd frame-header bit is set",
        ));
    }

    let content_size_flag = descriptor >> 6;
    let single_segment = descriptor & 0x20 != 0;
    let has_checksum = descriptor & 0x04 != 0;
    let dictionary_flag = descriptor & 0x03;
    let dictionary_bytes = if dictionary_flag == 3 {
        4
    } else {
        dictionary_flag as usize
    };
    let content_size_bytes = if content_size_flag == 0 {
        usize::from(single_segment)
    } else {
        1usize << content_size_flag
    };
    let rest_header = usize::from(!single_segment) + dictionary_bytes + content_size_bytes;
    if data.len().saturating_sub(offset) < rest_header {
        return Ok(FrameBoundary::Torn);
    }
    offset += rest_header;

    loop {
        if data.len().saturating_sub(offset) < 3 {
            return Ok(FrameBoundary::Torn);
        }
        let block_header = u32::from(data[offset])
            | (u32::from(data[offset + 1]) << 8)
            | (u32::from(data[offset + 2]) << 16);
        offset += 3;
        let last_block = block_header & 1 != 0;
        let block_type = (block_header >> 1) & 0x03;
        let block_size = (block_header >> 3) as usize;
        if block_type == 0x03 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reserved zstd block type",
            ));
        }
        let payload_bytes = if block_type == 0x01 { 1 } else { block_size };
        if data.len().saturating_sub(offset) < payload_bytes {
            return Ok(FrameBoundary::Torn);
        }
        offset += payload_bytes;
        if last_block {
            break;
        }
    }

    if has_checksum {
        if data.len().saturating_sub(offset) < 4 {
            return Ok(FrameBoundary::Torn);
        }
        offset += 4;
    }
    Ok(FrameBoundary::Complete {
        end: offset,
        skippable: false,
    })
}

/// Decode exactly one complete zstd frame. The returned byte count is the
/// compressed frame boundary even when concatenated frames follow it.
pub fn decode_zstd_frame(data: &[u8]) -> io::Result<(String, usize)> {
    let FrameBoundary::Complete { end, skippable } = scan_frame(data)? else {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "incomplete zstd frame",
        ));
    };
    if skippable {
        return Ok((String::new(), end));
    }

    let mut cursor = Cursor::new(&data[..end]);
    let mut decoder = Decoder::with_buffer(&mut cursor)?.single_frame();
    let mut output = Vec::new();
    decoder
        .by_ref()
        .take(MAX_DECOMPRESSED_FRAME_SIZE + 1)
        .read_to_end(&mut output)?;
    if output.len() as u64 > MAX_DECOMPRESSED_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zstd frame expands beyond 32 MiB limit",
        ));
    }
    let text = String::from_utf8(output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok((text, end))
}

/// Decode all complete frames. A torn trailing frame remains unconsumed so the
/// watcher can retry it after the next append.
pub fn decode_complete_frames(data: &[u8]) -> io::Result<(String, usize)> {
    let mut output = String::new();
    let mut consumed = 0usize;
    while consumed < data.len() {
        match scan_frame(&data[consumed..])? {
            FrameBoundary::Torn => break,
            FrameBoundary::Complete { .. } => {
                let (text, frame_bytes) = decode_zstd_frame(&data[consumed..])?;
                output.push_str(&text);
                consumed += frame_bytes;
            }
        }
    }
    Ok((output, consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn encode(text: &[u8]) -> Vec<u8> {
        let mut encoder = zstd::Encoder::new(Vec::new(), 3).unwrap();
        encoder.write_all(text).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn decodes_one_frame_from_concatenated_input() {
        let first = encode(b"frame1");
        let second = encode(b"frame2");
        let combined = [first.as_slice(), second.as_slice()].concat();
        let (decoded, consumed) = decode_zstd_frame(&combined).unwrap();
        assert_eq!(decoded, "frame1");
        assert_eq!(consumed, first.len());
    }

    #[test]
    fn decodes_complete_frame_and_leaves_torn_tail() {
        let first = encode(b"one\n");
        let second = encode(b"two\n");
        let input = [first.as_slice(), &second[..second.len() / 2]].concat();
        let (decoded, consumed) = decode_complete_frames(&input).unwrap();
        assert_eq!(decoded, "one\n");
        assert_eq!(consumed, first.len());
    }

    #[test]
    fn decodes_all_complete_frames() {
        let first = encode(b"one\n");
        let second = encode(b"two\n");
        let combined = [first.as_slice(), second.as_slice()].concat();
        let (decoded, consumed) = decode_complete_frames(&combined).unwrap();
        assert_eq!(decoded, "one\ntwo\n");
        assert_eq!(consumed, combined.len());
    }

    #[test]
    fn skips_complete_skippable_frames() {
        let mut skipped = 0x184D2A50u32.to_le_bytes().to_vec();
        skipped.extend_from_slice(&3u32.to_le_bytes());
        skipped.extend_from_slice(b"xyz");
        let actual = encode(b"event\n");
        let input = [skipped.as_slice(), actual.as_slice()].concat();
        let (decoded, consumed) = decode_complete_frames(&input).unwrap();
        assert_eq!(decoded, "event\n");
        assert_eq!(consumed, input.len());
    }
}
