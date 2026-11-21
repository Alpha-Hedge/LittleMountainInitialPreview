[CmdletBinding()]
param(
    [ValidateSet("start","configure","status","stop","verify","logs")] [string]$Action = "start",
    [switch]$TestStack
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$originalPath = $env:Path
Push-Location $root
try {
    $envFile = if ($TestStack) { ".env.nfip-test" } else { ".env.nfip" }
    $project = if ($TestStack) { "lmm-engineering-test" } else { "lmm-engineering" }
    $port = if ($TestStack) { 8141 } else { 8140 }
    if (!(Test-Path -LiteralPath $envFile)) {
        if ($Action -notin @("start","configure")) { throw "Configure this stack first." }
        $target = Join-Path $root $envFile
        $temporary = Join-Path $root (".env.nfip-init-" + [Guid]::NewGuid())
        $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $stream.Close()
        try {
            if ($env:OS -eq "Windows_NT") {
                $acl = Get-Acl -LiteralPath $temporary
                $acl.SetAccessRuleProtection($true,$false)
                $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow")
                $acl.AddAccessRule($rule)
                Set-Acl -LiteralPath $temporary -AclObject $acl
            } else {
                & chmod 600 $temporary
                if ($LASTEXITCODE) { throw "Could not restrict the settings file." }
            }
            $lines = @("NFIP_API_PORT=$port","NFIP_API_URL=http://127.0.0.1:$port")
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                foreach ($key in @("DB_OWNER_PASSWORD","DB_PASSWORD","REDIS_PASSWORD","S3_OWNER_PASSWORD","S3_PASSWORD","API_TOKEN")) {
                    $bytes = New-Object byte[] 32
                    $rng.GetBytes($bytes)
                    $value = [BitConverter]::ToString($bytes).Replace("-","").ToLowerInvariant()
                    $lines += "NFIP_$key=$value"
                }
            } finally { $rng.Dispose() }
            [IO.File]::WriteAllLines($temporary,$lines,(New-Object Text.UTF8Encoding($false)))
            [IO.File]::Move($temporary,$target)
            Write-Host "Created private settings for $project."
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        }
    }
    if ($Action -eq "configure") { return }
    if ($env:OS -eq "Windows_NT" -and !(Get-Command docker -ErrorAction SilentlyContinue)) {
        foreach ($bin in @("$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin", "$env:ProgramFiles\Docker\Docker\resources\bin")) {
            if (Test-Path -LiteralPath (Join-Path $bin "docker.exe")) {
                $env:Path = "$bin;$originalPath"
                break
            }
        }
    }
    $useWsl = !(Get-Command docker -ErrorAction SilentlyContinue)
    function Invoke-Compose {
        $cmdArgs = @("compose")
        if (Test-Path -LiteralPath ".env.local") { $cmdArgs += @("--env-file",".env.local") }
        $cmdArgs += @("--env-file",$envFile,"--project-name",$project) + $args
        if ($useWsl) {
            & wsl -d Ubuntu-24.04 -- docker @cmdArgs
        } else {
            & docker @cmdArgs
        }
        if ($LASTEXITCODE) { throw "Docker Compose failed for $project (exit $LASTEXITCODE)." }
    }
    switch ($Action) {
        start {
            Invoke-Compose build minio api
            Invoke-Compose up -d --wait --wait-timeout 240
        }
        status { Invoke-Compose ps --all }
        stop { Invoke-Compose stop }
        logs { Invoke-Compose logs --tail 75 }
        verify {
            if (!$TestStack) { throw "Use -TestStack for the write and restart checks." }
            Invoke-Compose exec -T api python -m tests.integration
            Invoke-Compose exec -T api python -m tests.quote_rag
            Invoke-Compose exec -T api python -m tests.nick_rule_api
            Invoke-Compose exec -T api python -m tests.preferences
            Invoke-Compose exec -T api python -m tests.real_audit_controls
        }
    }
} finally {
    $env:Path = $originalPath
    Pop-Location
}

