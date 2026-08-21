param(
    [ValidateSet("frontend", "backend")]
    [Parameter(Mandatory=$true, Position=0)]
    [string]$image = "",
    [switch]$NoCache,
    [switch]$SmartChache,
    [switch]$JustRun,
    [switch]$JustBuild,
    [switch]$PullLatestBaseImage
)

if($JustRun -and ($NoCache -or $SmartChache -or $PullLatestBaseImage)) {
    throw "Cannot use -JustRun together with -NoCache or -SmartChache or -PullLatestBaseImage."
}
if($SmartChache -and $NoCache) {
    throw "Cannot use -SmartChache and -NoCache together."
}
if($SmartChache -and $PullLatestBaseImage) {
    throw "Cannot use -SmartChache and -PullLatestBaseImage together."
}
if($PullLatestBaseImage -and ($NoCache -eq $false)) {
    $NoCache = $true
    Write-Host "Note: -PullLatestBaseImage implies -NoCache, so enabling -NoCache."
}
if($JustRun -and $JustBuild) {
    throw "Cannot use -JustRun and -JustBuild together."
}

# current path of the script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# The backend image installs Python packages with pip. On machines behind a package feed
# proxy, pypi.org/files.pythonhosted.org is unreachable from inside the container, so mirror
# the host's configured index-url into the build.
function Get-PipIndexUrl {
    $defaultIndex = "https://pypi.org/simple"

    if ($env:PIP_INDEX_URL) {
        return $env:PIP_INDEX_URL
    }
    if (-not (Get-Command pip -ErrorAction SilentlyContinue)) {
        return $defaultIndex
    }

    $config = (& pip config list 2>$null | Out-String)
    if ($config -match "global\.index-url\s*=\s*['`"]?([^'`"\r\n]+)") {
        return $Matches[1].Trim()
    }
    return $defaultIndex
}

if($image -eq "frontend") {
    Write-Host "$scriptDir/frontend"
    Set-Location "$scriptDir/frontend"
    Write-Host "Building and running frontend..."
    if(-not $JustRun) {
        try {
            if($NoCache) {
                docker rmi rdp-frontend:latest | Out-Null
                if($PullLatestBaseImage) {
                    docker build --no-cache --pull -t rdp-frontend .
                    if($LASTEXITCODE -ne 0) {
                        throw "Docker build failed with exit code $LASTEXITCODE"
                    }
                }
                else {
                    docker build --no-cache -t rdp-frontend .
                    if($LASTEXITCODE -ne 0) {
                        throw "Docker build failed with exit code $LASTEXITCODE"
                    }
                }
            }
            else {
                docker build -t rdp-frontend .
                if($LASTEXITCODE -ne 0) {
                    throw "Docker build failed with exit code $LASTEXITCODE"
                }
            }
        }
        finally {
            Set-Location $scriptDir
        }
    }
    if(-not $JustBuild) {
        docker run --rm -it -p 8000:8000 --name rdp-frontend rdp-frontend
    }
}
elseif($image -eq "backend") {
    Set-Location "$scriptDir/backend"
    Write-Host "Building and running backend..."
    if(-not $JustRun) {
        $pipIndexUrl = Get-PipIndexUrl
        Write-Host "Using pip index: $pipIndexUrl"
        try {
            if($NoCache) {
                docker rmi rdp-backend:latest | Out-Null
                if($PullLatestBaseImage) {
                    docker build --no-cache --pull -t rdp-backend --build-arg PIP_INDEX_URL=$pipIndexUrl .
                    if($LASTEXITCODE -ne 0) {
                        throw "Docker build failed with exit code $LASTEXITCODE"
                    }
                }
                else {
                    docker build --no-cache -t rdp-backend --build-arg PIP_INDEX_URL=$pipIndexUrl .
                    if($LASTEXITCODE -ne 0) {
                        throw "Docker build failed with exit code $LASTEXITCODE"
                    }
                }
            }
            else {
                if($SmartChache) {
                    $REBUILD_NEEDED = Get-Date -Format 'yyyy-MM-dd--hh-mm-ss'
                }
                else {
                    $REBUILD_NEEDED = "0"
                }

                docker build -t rdp-backend --build-arg REBUILD_NEEDED=$REBUILD_NEEDED --build-arg PIP_INDEX_URL=$pipIndexUrl .
                if($LASTEXITCODE -ne 0) {
                    throw "Docker build failed with exit code $LASTEXITCODE"
                }
            }
        }
        finally {
            Set-Location $scriptDir
        }
    }
    if(-not $JustBuild) {
        # to test the security policy
        # docker run --rm -it -p 8765:8765 -v "$scriptDir\backend\security:/app/security" --name rdp-backend  rdp-backend
        docker run --rm -it -p 8765:8765 --name rdp-backend  rdp-backend
    }
}
else {
    Write-Host "Please specify an image to build and run: -image frontend or -image backend"
}