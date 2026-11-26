#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
destination="$PWD/tests/fixtures/generated/beauty-dev"
mkdir -p "$destination"
cd "$destination"

fixture() {
  local file="$1" url="$2" digest="$3"
  if [[ ! -f "$file" ]]; then
    curl -fsSL --retry 2 -A 'OpenCut-development-fixture/0.12' "$url" -o "$file"
  fi
  printf '%s  %s\n' "$digest" "$file" | shasum -a 256 -c
}

# Attribution and source terms are in tests/fixtures/README.md.
fixture squat.webm \
  https://upload.wikimedia.org/wikipedia/commons/5/5c/Squat_-_exercise_demonstration_video.webm \
  2440985661c3533a4ce78472b0f4577dbdf023aff3f8f9a225bbb5ff8071b1e9
fixture interview.webm \
  https://upload.wikimedia.org/wikipedia/commons/d/d8/T-60_Seconds_with_Jessica_Meir.webm \
  97a0a52d4359f4e81c4eb40ac3570f8c79a8dd8835d5e5e004736dd08ed7a9d6

encode() {
  local offset="$1" source="$2" output="$3"
  shift 3
  if [[ ! -f "$output" ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss "$offset" -i "$source" \
      -t 2 -vf scale=640:360 -c:v libx264 \
      -color_primaries bt709 -color_trc bt709 -colorspace bt709 -pix_fmt yuv420p \
      "$@" -n "$output"
  fi
}
encode 0.7 squat.webm body.mp4 -an
encode 14 interview.webm face.mp4 -c:a aac

if [[ "${1:-}" == --held-out ]]; then
  mkdir -p held-out
  cd held-out
  fixture cdc-half-squat.webm \
    https://upload.wikimedia.org/wikipedia/commons/a/ae/Muscle_Strengthening_at_Home_-_Half_squat.webm \
    d067de9dd6097f08403deac771f2dd5fe579e33e9b6937003bfa73ba2944a338
  if [[ ! -f held-out.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 61.8 -i cdc-half-squat.webm \
      -t 2 -vf fps=30 -c:v libx264 -pix_fmt yuv420p -c:a aac -n held-out.mp4
  fi
  mkdir -p full-body
  fixture full-body/jumping-jacks.webm \
    https://upload.wikimedia.org/wikipedia/commons/5/57/Jumping_jacks_and_burpees.webm \
    1c8370a29c52b5b1538f03f8c63be6cdc9333dea3cbd77cc8f2af0dbe496d5b4
  if [[ ! -f full-body/source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 0.6 -i full-body/jumping-jacks.webm \
      -vf fps=24 -frames:v 54 -c:v libx264 -pix_fmt yuv420p -an -n full-body/source.mp4
  fi
  mkdir -p ../length-dev
  if [[ ! -f ../length-dev/wide.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 17.17 -i cdc-half-squat.webm \
      -t 1.8 -vf fps=24 -c:v libx264 -pix_fmt yuv420p -an -n ../length-dev/wide.mp4
  fi
fi

if [[ "${1:-}" == --native-4k ]]; then
  mkdir -p native-4k-motion native-4k-pair
  fixture native-4k-motion/source.mp4 \
    https://videos.pexels.com/video-files/2785532/2785532-uhd_2160_3840_25fps.mp4 \
    3d92a21aa5b843cd1c6d7e54176c65e41dc6280a39a9307f8d3c02b564da3050
  fixture native-4k-pair/source.mp4 \
    https://videos.pexels.com/video-files/4859226/4859226-uhd_3840_2160_25fps.mp4 \
    c0055bf9c54797927337f86ec22686608f062adb93efed76294f5bde696914fd
fi

if [[ "${1:-}" == --acceptance-corpus ]]; then
  mkdir -p held-out/production-corpus
  cd held-out/production-corpus
  fixture portrait-smile.mp4 \
    https://videos.pexels.com/video-files/6693714/6693714-hd_1080_2048_30fps.mp4 \
    e88707529141305e3c485862edc118df330102608e0dd5a847d49a23013fe2de
  fixture portrait-speech.mp4 \
    https://videos.pexels.com/video-files/6534947/6534947-hd_1080_1920_24fps.mp4 \
    6fc47d2c4badb5c719d2783ddbbf7e60f8447aef4aa383e159aabd162901ecbf
  fixture dance-crossing.mp4 \
    https://videos.pexels.com/video-files/8670603/8670603-hd_1280_720_25fps.mp4 \
    e9b26ebb9873a0d1da1d84c35fdd2f67201e8bab2b871760ecf6a3580f66e5e8
  fixture walking-past.mp4 \
    https://videos.pexels.com/video-files/9710752/9710752-hd_1080_1920_25fps.mp4 \
    66d185de63a9d7d611d15ebb0bc43d1ac114e57e71de1ee0300739ab63c81666
  if [[ ! -f smile-source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 0.45 -i portrait-smile.mp4 \
      -vf scale=432:-2 -frames:v 120 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n smile-source.mp4
  fi
  if [[ ! -f speech-source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 6.0 -i portrait-speech.mp4 \
      -vf scale=432:768 -frames:v 120 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n speech-source.mp4
  fi
  if [[ ! -f overlap-source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 15.0 -i dance-crossing.mp4 \
      -vf scale=640:360 -frames:v 200 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n overlap-source.mp4
  fi
  if [[ ! -f walking-source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -i walking-past.mp4 \
      -vf scale=432:768 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n walking-source.mp4
  fi
fi

if [[ "${1:-}" == --portrait-geometry ]]; then
  mkdir -p held-out/production-corpus/combined-portrait-candidates
  cd held-out/production-corpus/combined-portrait-candidates
  fixture glasses-original.mp4 \
    https://videos.pexels.com/video-files/10515012/10515012-hd_3840_2160_24fps.mp4 \
    6fe69cc110f586c08736a8115be77d15cad6feb7e4cbe913b1c90c17cb8dab61
  fixture seated-original.mp4 \
    https://videos.pexels.com/video-files/8057123/8057123-hd_1920_1080_25fps.mp4 \
    aa0248df82b270addedc6185b533583af63bf08348853dbf048fb4abb35e4130
  fixture brick-original.mp4 \
    https://videos.pexels.com/video-files/6548010/6548010-uhd_2160_3840_24fps.mp4 \
    f060dd714a1c02834d07aaf7a99a0c53a79bfa556cac87eed38a21bd414e7a00

  portrait_excerpt() {
    local name="$1" offset="$2" size="$3" rate="$4"
    if [[ ! -f "$name-source.mp4" ]]; then
      ffmpeg -nostdin -hide_banner -loglevel error -ss "$offset" -i "$name-original.mp4" \
        -vf "scale=$size,fps=$rate" -frames:v 60 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n "$name-source.mp4"
    fi
  }
  portrait_excerpt glasses 2.5 640:360 24
  portrait_excerpt seated 5 640:360 25
  portrait_excerpt brick 3.5 432:768 24
  fixture studio-original.mp4 \
    https://videos.pexels.com/video-files/7812511/7812511-uhd_3840_2160_25fps.mp4 \
    1f53ee6857896daaaa6955cd556ef8178fb11d2bc49394d0918ae492b2f10ad4
  if [[ ! -f studio-context.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -i studio-original.mp4 \
      -vf scale=640:-2,fps=25 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n studio-context.mp4
  fi
  if [[ ! -f studio-source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 4.8 -i studio-context.mp4 \
      -frames:v 45 -c:v libx264 -crf 16 -pix_fmt yuv420p -an -n studio-source.mp4
  fi
fi

if [[ "${1:-}" == --vertical-performance ]]; then
  mkdir -p native-4k-stance/vertical-grounded
  cd native-4k-stance
  fixture deck-original.mp4 \
    https://videos.pexels.com/video-files/8859851/8859851-uhd_2160_3840_25fps.mp4 \
    2e4ababb4b7ef4932a535e0c32e29617922d584e8eeab19d3b059dc1de494a25
  if [[ ! -f vertical-grounded/source.mp4 ]]; then
    ffmpeg -nostdin -hide_banner -loglevel error -ss 22.4 -i deck-original.mp4 \
      -frames:v 25 -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p -an -n vertical-grounded/source.mp4
  fi
fi
