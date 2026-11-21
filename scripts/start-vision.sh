#!/usr/bin/env bash
# Run from Ubuntu 24.04 x86-64, including WSL2.
set -euo pipefail
project="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cache="$project/.local-vision"
mkdir -p "$cache"
cd "$cache"
fetch() {
  local url="$1" name="$2" sha="$3"
  if [[ ! -f "$name" ]]; then
    curl --fail --location --retry 3 --output "$name.partial" "$url"
    echo "$sha  $name.partial" | sha256sum --check --status
    mv -- "$name.partial" "$name"
  fi
}
archive=llama-b12503-bin-ubuntu-x64.tar.gz
fetch "https://github.com/ggml-org/llama.cpp/releases/download/b12503/$archive" "$archive" 0d585f8a78ffdfdc4f6303a089aaa1379c15323b33483b6548c85c774a376a9d
if [[ ! -f linux/llama-server ]]; then
  mkdir -p linux
  tar --extract --gzip --file "$archive" --directory linux --strip-components 1
fi
base=https://huggingface.co/ggml-org/Qwen3-VL-2B-Instruct-GGUF/resolve/ea6a11058182570be6436b9a2e4ee7f7b49f908d
model=Qwen3-VL-2B-Instruct-Q8_0.gguf
fetch "$base/$model" "$model" b7802e29f71a9e5b5e3f83f613df898a2204342dcea71a231ea501d481813c39
fetch "$base/mmproj-$model" "mmproj-$model" 69066c8f279ec85ff48ab4059f6ebba0d2932ca57667f2bbdac7d9805bca9e7b
# Bound the request cache and image working set on a shared 16 GB workstation.
exec ./linux/llama-server -m "$model" --mmproj "mmproj-$model" --alias Qwen3-VL-2B-Instruct \
  --host 127.0.0.1 --port 8187 -c 16384 -np 1 -t 6 --no-ui --cache-ram 0 \
  -b 256 -ub 128 --image-max-tokens 576 --mtmd-batch-max-tokens 512 \
  --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --load-mode none
