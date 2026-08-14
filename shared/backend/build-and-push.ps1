# =====================================================
# 共享云托管后端 镜像构建 + 推送脚本（腾讯云 CCR）
# 用法：
#   .\build-and-push.ps1                 # 用默认 latest 标签
#   .\build-and-push.ps1 -Tag v1.2.3     # 自定义标签
#   .\build-and-push.ps1 -LoginOnly      # 仅登录
# 密码从环境变量 TENCENT_CCR_PASSWORD 读取；未设置则交互输入（不落盘、不进 shell 历史）。
# =====================================================
param(
  [string]$Tag = "1.0",
  [switch]$LoginOnly
)

$ErrorActionPreference = "Stop"

$Registry = "ccr.ccs.tencentyun.com"
$Username = "100051593824"
$Namespace = "simon-k8s"
$RepoName = "kxm-service"
$Image = "${Registry}/${Namespace}/${RepoName}:${Tag}"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 1. 登录 ----
$Password = $env:TENCENT_CCR_PASSWORD
if (-not $Password) {
  $Password = Read-Host "请输入 CCR 密码" -AsSecureString
  $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
  $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
}
$Password | docker login $Registry --username $Username --password-stdin
if ($LASTEXITCODE -ne 0) { throw "docker login 失败" }
Write-Host "[ok] 登录成功: $Registry" -ForegroundColor Green

if ($LoginOnly) { exit 0 }

# ---- 2. 构建（Dockerfile 上下文为 shared/backend/ 目录） ----
Write-Host "[build] $Image"
docker build -t $Image $ScriptDir
if ($LASTEXITCODE -ne 0) { throw "docker build 失败" }

# ---- 3. 推送 ----
Write-Host "[push] $Image"
docker push $Image
if ($LASTEXITCODE -ne 0) { throw "docker push 失败" }

Write-Host "[done] 已推送 $Image" -ForegroundColor Green
