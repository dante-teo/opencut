mod audio;
mod video;

use std::error::Error;
use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{self, ChildStdout, Command, Stdio};

use serde::Deserialize;

const PROTOCOL: u32 = 1;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: u32,
    release: String,
    max_allocation_bytes: Option<u32>,
    job: Job,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Job {
    GraphicAudio {
        path: PathBuf,
        samples: usize,
        window: usize,
        hop: usize,
        waveform: usize,
        bins: usize,
    },
    FrameIndex {
        path: PathBuf,
        stream: u32,
    },
    CountVideo {
        path: PathBuf,
    },
}

fn media_tool(tool: &str, max_allocation_bytes: Option<u32>) -> Command {
    let mut command = Command::new(tool);
    if let Some(limit) = max_allocation_bytes {
        command.args(["-max_alloc", &limit.to_string()]);
    }
    command
        .args(["-v", "error"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    command
}

fn process_output(
    mut command: Command,
    consume: impl FnOnce(ChildStdout) -> Result<()>,
) -> Result<()> {
    let tool = command.get_program().to_string_lossy().into_owned();
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            format!("Required executable '{tool}' was not found on PATH. Install FFmpeg/ffprobe manually to use media commands.")
        } else {
            format!("Cannot start {tool}: {err}")
        }
    })?;
    let result = consume(child.stdout.take().expect("piped stdout"));
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    result?;
    if !status.success() {
        return Err(format!("{tool} failed ({status}).").into());
    }
    Ok(())
}

fn application_version() -> Result<String> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }
    let manifest: Manifest = serde_json::from_str(include_str!("../../../package.json"))?;
    Ok(manifest.version)
}

#[cfg(unix)]
fn watch_owner() -> Result<()> {
    // Node starts a fresh session. Reject a shared group before starting the
    // guard, so a direct invocation cannot signal the caller's other jobs.
    let pid = process::id() as libc::pid_t;
    if unsafe { libc::getpgrp() } != pid {
        return Err("OpenCut media jobs require a private process group.".into());
    }
    std::thread::Builder::new()
        .name("opencut-owner".into())
        .spawn(move || {
            // The parent's write end stays open until the job exits. The media
            // tool inherits /dev/null, so it cannot keep this channel alive.
            let _ = io::stdin().read(&mut [0]);
            unsafe { libc::killpg(pid, libc::SIGKILL) };
        })?;
    Ok(())
}

#[cfg(not(unix))]
fn watch_owner() -> Result<()> {
    Err("The OpenCut native media engine requires a Unix process group.".into())
}

fn run() -> Result<()> {
    let version = application_version()?;
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--version"), None, None) => {
            println!("{version}");
            return Ok(());
        }
        (Some("--protocol"), None, None) => {
            println!("{version} {PROTOCOL}");
            return Ok(());
        }
        (Some("--job"), Some(request), None) => {
            let request: Request = serde_json::from_str(&request)?;
            if request.protocol != PROTOCOL || request.release != version {
                return Err(format!(
                    "Incompatible OpenCut media engine. Expected release {version} and protocol {PROTOCOL}."
                )
                .into());
            }
            watch_owner()?;
            let limit = request.max_allocation_bytes;
            let mut output = BufWriter::with_capacity(64 * 1024, io::stdout().lock());
            match request.job {
                Job::GraphicAudio {
                    path,
                    samples,
                    window,
                    hop,
                    waveform,
                    bins,
                } => {
                    let settings = audio::Settings::new(samples, window, hop, waveform, bins)?;
                    let mut command = media_tool("ffmpeg", limit);
                    command
                        .args([
                            "-nostdin",
                            "-xerror",
                            "-filter_threads",
                            "1",
                            "-threads",
                            "1",
                            "-i",
                        ])
                        .arg(path)
                        .args([
                            "-map", "0:a:0", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1",
                        ]);
                    process_output(command, |pcm| audio::measure(pcm, &mut output, settings))?;
                }
                Job::FrameIndex { path, stream } => {
                    let mut command = media_tool("ffprobe", limit);
                    command
                        .args([
                            "-select_streams",
                            &stream.to_string(),
                            "-show_frames",
                            "-show_entries",
                            "frame=pts,best_effort_timestamp,duration",
                            "-of",
                            "compact=p=1:nk=0",
                        ])
                        .arg(path);
                    process_output(command, |frames| video::index(frames, &mut output))?;
                }
                Job::CountVideo { path } => {
                    let mut command = media_tool("ffprobe", limit);
                    command
                        .args([
                            "-count_frames",
                            "-select_streams",
                            "v:0",
                            "-show_entries",
                            "stream=nb_read_frames",
                            "-of",
                            "json",
                        ])
                        .arg(path);
                    process_output(command, |frames| video::count(frames, &mut output))?;
                }
            }
            output.flush()?;
        }
        _ => return Err("Expected --version, --protocol, or --job with a media request.".into()),
    }
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}
