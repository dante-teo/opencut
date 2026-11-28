use std::io::{BufRead, BufReader, Read, Write};

use serde::Deserialize;

use crate::Result;

const MAX_SAFE_TICK: i64 = (1 << 53) - 1;
const MAX_RECORDS: usize = (32 * 1024 * 1024 - 8) / 24;
const MAX_LINE: u64 = 64 * 1024;
const UNAVAILABLE: i64 = i64::MIN;

fn optional_tick(value: &str) -> Result<Option<i64>> {
    if value == "N/A" {
        return Ok(None);
    }
    let tick: i64 = value.parse()?;
    if !(-MAX_SAFE_TICK..=MAX_SAFE_TICK).contains(&tick) {
        return Err("MP4 frame timestamp exceeds the supported integer range.".into());
    }
    Ok(Some(tick))
}

pub fn index(source: impl Read, mut output: impl Write) -> Result<()> {
    let mut reader = BufReader::with_capacity(64 * 1024, source);
    let mut line = String::new();
    let mut first = None;
    let mut previous = 0;
    let mut count = 0;
    loop {
        line.clear();
        let bytes = Read::by_ref(&mut reader)
            .take(MAX_LINE + 1)
            .read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        if bytes as u64 > MAX_LINE {
            return Err("FFprobe returned an oversized MP4 frame record.".into());
        }
        let mut fields = line.trim_end().split('|');
        if fields.next() != Some("frame") {
            continue;
        }
        let mut best_effort = None;
        let mut pts = None;
        let mut duration = None;
        for field in fields {
            match field.split_once('=') {
                Some(("best_effort_timestamp", value)) => best_effort = optional_tick(value)?,
                Some(("pts", value)) => pts = optional_tick(value)?,
                Some(("duration", value)) => duration = optional_tick(value)?,
                _ => {}
            }
        }
        let tick = best_effort.ok_or("MP4 frames do not have ordered presentation timestamps.")?;
        if first.is_none() {
            output.write_all(&tick.to_le_bytes())?;
        }
        let delta = tick - *first.get_or_insert(tick);
        if delta < previous || delta > MAX_SAFE_TICK {
            return Err("MP4 frames do not have ordered presentation timestamps.".into());
        }
        previous = delta;
        count += 1;
        if count > MAX_RECORDS {
            return Err("MP4 frame index exceeds 32 MiB.".into());
        }
        for word in [
            pts.unwrap_or(UNAVAILABLE),
            duration.unwrap_or(UNAVAILABLE),
            delta,
        ] {
            output.write_all(&word.to_le_bytes())?;
        }
    }
    if first.is_none() {
        return Err("MP4 has no decoded video frames.".into());
    }
    Ok(())
}

pub fn count(source: impl Read, mut output: impl Write) -> Result<()> {
    #[derive(Deserialize)]
    struct Stream {
        nb_read_frames: Option<String>,
    }

    #[derive(Deserialize)]
    struct Counts {
        #[serde(default)]
        streams: Vec<Stream>,
    }

    let mut data = Vec::new();
    source.take(MAX_LINE + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_LINE {
        return Err("FFprobe returned an oversized decoded frame count.".into());
    }
    let response: Counts = serde_json::from_slice(&data)?;
    let count = response
        .streams
        .first()
        .and_then(|stream| stream.nb_read_frames.as_deref());
    if let Some(value) = count.filter(|value| *value != "N/A") {
        let count: u64 = value.parse()?;
        if count > MAX_SAFE_TICK as u64 {
            return Err("Decoded video frame count exceeds the supported integer range.".into());
        }
        output.write_all(&count.to_le_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_negative_origin_and_vfr_gap_without_confusing_pts_and_presentation_order() {
        let text = b"frame|pts=-900|best_effort_timestamp=-900|duration=3|side_datum:ignored=1\nframe|pts=N/A|best_effort_timestamp=-897|duration=3\nframe|pts=-200|best_effort_timestamp=-200\n";
        let mut result = Vec::new();
        index(&text[..], &mut result).unwrap();
        let words: Vec<_> = result
            .chunks_exact(8)
            .map(|word| i64::from_le_bytes(word.try_into().unwrap()))
            .collect();
        assert_eq!(
            words,
            [-900, -900, 3, 0, UNAVAILABLE, 3, 3, -200, UNAVAILABLE, 700]
        );
    }

    #[test]
    fn rejects_backward_missing_and_unsafe_ticks() {
        for source in [
            "frame|best_effort_timestamp=4\nframe|best_effort_timestamp=3\n",
            "frame|best_effort_timestamp=N/A\n",
            "frame|best_effort_timestamp=9007199254740992\n",
        ] {
            assert!(index(source.as_bytes(), Vec::new()).is_err());
        }
        assert!(index(&[][..], Vec::new()).is_err());
    }

    #[test]
    fn converts_only_decoded_frame_counts() {
        let mut result = Vec::new();
        count(
            &br#"{"streams":[{"nb_frames":"13","nb_read_frames":"12"}]}"#[..],
            &mut result,
        )
        .unwrap();
        assert_eq!(result, 12_u64.to_le_bytes());
        result.clear();
        count(&br#"{"streams":[{"nb_frames":"13"}]}"#[..], &mut result).unwrap();
        assert!(result.is_empty());
    }
}
