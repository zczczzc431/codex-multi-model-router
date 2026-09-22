$ErrorActionPreference = 'Stop'

$relayConfigPath = 'C:\Users\Administrator\.codex\relay-models.json'
if (-not (Test-Path -LiteralPath $relayConfigPath)) {
    throw "未找到中继配置：$relayConfigPath"
}

$relayConfig = Read-JsonFile -Path $relayConfigPath
$providers = @($relayConfig.providers.PSObject.Properties)
if ($providers.Count -eq 0) { throw '中继配置中没有任何供应商。' }

$chosen = if ($providers.Count -eq 1) {
    $providers[0]
} else {
    Write-Host '请选择要更新密钥的中继：'
    for ($i = 0; $i -lt $providers.Count; $i++) {
        Write-Host "  [$($i + 1)] $($providers[$i].Name) - $($providers[$i].Value.host)"
    }
    $answer = Read-Host '输入序号'
    $index = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $providers.Count) {
        throw '序号无效。'
    }
    $providers[$index - 1]
}

$credentialPath = [string]$chosen.Value.apiKeyFile
if (-not $credentialPath) { throw '该供应商未配置密钥文件路径。' }

Write-Host "请输入 $($chosen.Name) ($($chosen.Value.host)) 的 API 密钥。输入内容不会显示："
$secureKey = Read-Host -AsSecureString
$protectedKey = $secureKey | ConvertFrom-SecureString
[IO.File]::WriteAllText($credentialPath, $protectedKey, [Text.Encoding]::ASCII)

$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $credentialPath /inheritance:r /grant:r "*$userSid`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null

& (Join-Path $PSScriptRoot 'Activate-ModelRouter.ps1')

Write-Host "$($chosen.Name) 的密钥已加密保存，模型路由已重启。" -ForegroundColor Green
