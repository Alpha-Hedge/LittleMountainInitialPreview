param([string]$WslDistro, [string]$Python)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try {
    if ($WslDistro) {
        $setup = @'
set -eu
target="$HOME/.local/share/lmm-phase1-venv"
if ! "$target/bin/python" -m pip --version >/dev/null 2>&1; then
    python3.12 -m venv --without-pip "$target"
    bootstrap=$(mktemp)
    trap 'rm -f "$bootstrap"' EXIT
    curl --fail --silent --show-error https://bootstrap.pypa.io/get-pip.py -o "$bootstrap"
    "$target/bin/python" "$bootstrap"
fi
"$target/bin/python" -m pip install --disable-pip-version-check -r requirements-engineering.txt
"$target/bin/python" -c "import cv2, ezdxf, pydantic, reportlab, shapely"
'@
        # WSL receives literal POSIX shell through stdin, including paths containing spaces.
        $setup.Replace("`r","") | wsl.exe -d $WslDistro --cd $root -- bash -s
        if ($LASTEXITCODE) { throw "Engineering runtime setup failed in $WslDistro." }
        $venv = (wsl.exe -d $WslDistro -- sh -c 'echo "$HOME/.local/share/lmm-phase1-venv/bin/python"').Trim()
        [IO.File]::WriteAllText((Join-Path $root ".nfip-runtime.json"), (@{ distro=$WslDistro; interpreter=$venv } | ConvertTo-Json))
    } else {
        if ($Python) { & $Python -m venv .venv }
        else { py -3.12 -m venv .venv }
        if ($LASTEXITCODE) { throw "Install Python 3.12 or use -WslDistro Ubuntu-24.04." }
        & .\.venv\Scripts\python.exe -m pip install -r requirements-engineering.txt
        if ($LASTEXITCODE) { throw "Installing engineering packages failed." }
        & .\.venv\Scripts\python.exe -c "import cv2, ezdxf, pydantic, reportlab, shapely"
        if ($LASTEXITCODE) { throw "Native engineering libraries could not load. Run this script with -WslDistro Ubuntu-24.04." }
        if (Test-Path -LiteralPath ".nfip-runtime.json") { Remove-Item -LiteralPath ".nfip-runtime.json" }
    }
    Write-Host "Engineering runtime ready."
} finally { Pop-Location }
