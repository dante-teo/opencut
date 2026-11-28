use std::f64::consts::TAU;
use std::io::{self, BufReader, Read, Write};

use realfft::RealFftPlanner;

use crate::Result;

const PAYLOAD_LIMIT: usize = 64 * 1024 * 1024;

pub struct Settings {
    samples: usize,
    window: usize,
    hop: usize,
    waveform: usize,
    bins: usize,
    rows: usize,
}

impl Settings {
    pub fn new(
        samples: usize,
        window: usize,
        hop: usize,
        waveform: usize,
        bins: usize,
    ) -> Result<Self> {
        if !matches!(window, 512 | 1024 | 2048 | 4096)
            || !(256..=window).contains(&hop)
            || !(2..=192).contains(&waveform)
            || !(2..=96).contains(&bins)
        {
            return Err("Invalid graphics audio analysis settings.".into());
        }
        let rows = samples.div_ceil(hop) + 1;
        if rows > PAYLOAD_LIMIT / (4 * (1 + waveform + bins)) {
            return Err(
                "Audio analysis exceeds 64 MiB. Increase hop or reduce output features.".into(),
            );
        }
        Ok(Self {
            samples,
            window,
            hop,
            waveform,
            bins,
            rows,
        })
    }
}

struct Spectrum {
    ring: Vec<f32>,
    hann: Vec<f64>,
    bucket: Vec<usize>,
    input: Vec<f64>,
    output: Vec<realfft::num_complex::Complex64>,
    scratch: Vec<realfft::num_complex::Complex64>,
    fft: std::sync::Arc<dyn realfft::RealToComplex<f64>>,
    waveform: Vec<f32>,
    row: Vec<u8>,
    position: usize,
}

impl Spectrum {
    fn new(settings: &Settings) -> Self {
        let window = settings.window;
        let fft = RealFftPlanner::new().plan_fft_forward(window);
        Self {
            ring: vec![0.; window],
            hann: (0..window)
                // The previous analysis rounded the Hann weights to f32.
                .map(|i| (0.5 - 0.5 * (TAU * i as f64 / window as f64).cos()) as f32 as f64)
                .collect(),
            bucket: (0..window)
                .map(|i| i * settings.waveform / window)
                .collect(),
            input: fft.make_input_vec(),
            output: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            waveform: vec![0.; settings.waveform],
            row: vec![0; 4 * (1 + settings.waveform + settings.bins)],
            position: 0,
        }
    }

    fn push(&mut self, value: f32) {
        self.ring[self.position] = value;
        self.position = (self.position + 1) & (self.ring.len() - 1);
    }

    fn write_row(&mut self, output: &mut impl Write, bins: usize) -> Result<()> {
        self.waveform.fill(0.);
        let mut energy = 0.;
        let (head, tail) = self.ring.split_at(self.position);
        let samples = tail.iter().chain(head);
        for (((&sample, &weight), &bucket), input) in samples
            .zip(&self.hann)
            .zip(&self.bucket)
            .zip(&mut self.input)
        {
            let value = f64::from(sample);
            *input = value * weight;
            energy += value * value;
            if sample.abs() > self.waveform[bucket].abs() {
                self.waveform[bucket] = sample;
            }
        }
        self.fft
            .process_with_scratch(&mut self.input, &mut self.output, &mut self.scratch)?;
        let scale = self.ring.len() as f64;
        let values = std::iter::once((energy / scale).sqrt() as f32)
            .chain(self.waveform.iter().copied())
            .chain(self.output[..bins].iter().map(|bin| {
                // An FFT bin can only contain the sum of a finite number of f32 samples.
                (4. * (bin.re * bin.re + bin.im * bin.im).sqrt() / scale) as f32
            }));
        for (bytes, value) in self.row.chunks_exact_mut(4).zip(values) {
            bytes.copy_from_slice(&value.to_le_bytes());
        }
        output.write_all(&self.row)?;
        Ok(())
    }
}

pub fn measure(pcm: impl Read, mut output: impl Write, settings: Settings) -> Result<()> {
    let mut pcm = BufReader::with_capacity(64 * 1024, pcm);
    let mut spectrum = Spectrum::new(&settings);
    output.write_all(&(settings.rows as u32).to_le_bytes())?;
    let mut emitted = 0;
    let mut samples = 0;
    let mut next = settings.window / 2;
    let mut push = |sample| -> Result<()> {
        if emitted < settings.rows {
            spectrum.push(sample);
            samples += 1;
            if samples == next {
                spectrum.write_row(&mut output, settings.bins)?;
                next += settings.hop;
                emitted += 1;
            }
        }
        Ok(())
    };

    // Keep reading after the authored sample count so a truncated PCM sample
    // or a decoder failure cannot appear as a successful analysis.
    let mut decoded = 0;
    let mut bytes = [0; 4];
    while pcm.read(&mut bytes[..1])? != 0 {
        pcm.read_exact(&mut bytes[1..]).map_err(|err| {
            if err.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(err.kind(), "Incomplete PCM sample during audio analysis.")
            } else {
                err
            }
        })?;
        if decoded < settings.samples {
            push(f32::from_le_bytes(bytes))?;
            decoded += 1;
        }
    }
    let padded = (settings.rows - 1) * settings.hop + settings.window / 2;
    for _ in decoded..padded {
        push(0.)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn floats(data: &[u8]) -> Vec<f32> {
        data[4..]
            .chunks_exact(4)
            .map(|n| f32::from_le_bytes(n.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn centered_window_preserves_padding_signed_peak_and_fft_scaling() {
        let settings = Settings::new(1, 512, 256, 2, 2).unwrap();
        let mut result = Vec::new();
        measure(&(-0.5_f32).to_le_bytes()[..], &mut result, settings).unwrap();
        assert_eq!(&result[..4], &2_u32.to_le_bytes());
        let values = floats(&result);
        let expected_rms = (0.25_f64 / 512.).sqrt() as f32;
        assert_eq!(
            values,
            [
                expected_rms,
                0.,
                -0.5,
                1. / 256.,
                1. / 256.,
                expected_rms,
                -0.5,
                0.,
                0.,
                0.
            ]
        );
    }

    #[test]
    fn rejects_partial_samples_even_after_authored_duration() {
        let settings = Settings::new(0, 512, 256, 2, 2).unwrap();
        let error = measure(&[0; 5][..], Vec::new(), settings).unwrap_err();
        assert!(error.to_string().contains("Incomplete PCM sample"));
    }

    #[test]
    fn rejects_unbounded_or_invalid_settings() {
        assert!(Settings::new(usize::MAX, 512, 256, 2, 2).is_err());
        assert!(Settings::new(0, 512, 513, 2, 2).is_err());
        assert!(Settings::new(0, 513, 256, 2, 2).is_err());
        assert!(Settings::new(0, 512, 256, 193, 96).is_err());
    }
}
