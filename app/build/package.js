// Builds dist\Kiln-win32-x64\Kiln.exe and adds Desktop + Start Menu shortcuts.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mod = require('@electron/packager');
const packager = mod.packager || mod.default || mod;

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');

function kilnRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Kiln.exe', '/NH'], { encoding: 'utf8' });
    return /Kiln\.exe/i.test(out);
  } catch { return false; }
}

(async () => {
  if (kilnRunning()) {
    console.error('Kiln is running. Quit it from the tray icon (right-click > Quit Kiln), then build again.');
    process.exit(1);
  }
  require('./make-icons.js');
  // Build into a scratch folder first so a failed build never leaves a half-updated app behind.
  const staging = path.join(ROOT, 'dist-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  const [builtDir] = await packager({
    dir: APP,
    out: staging,
    overwrite: true,
    platform: 'win32',
    arch: 'x64',
    name: 'Kiln',
    executableName: 'Kiln',
    icon: path.join(APP, 'assets', 'icon.ico'),
    asar: true,
    prune: true,
    ignore: [/^\/build($|\/)/, /^\/data($|\/)/],
    win32metadata: { CompanyName: 'Kiln', FileDescription: 'Kiln', ProductName: 'Kiln', InternalName: 'Kiln' },
  });
  const outDir = path.join(ROOT, 'dist', path.basename(builtDir));
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(builtDir, outDir);
  fs.rmSync(staging, { recursive: true, force: true });
  const exe = path.join(outDir, 'Kiln.exe');
  console.log('Built', exe);

  const ps = `
    $s = New-Object -ComObject WScript.Shell
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))) {
      $l = $s.CreateShortcut((Join-Path $dir 'Kiln.lnk'))
      $l.TargetPath = '${exe}'
      $l.WorkingDirectory = '${outDir}'
      $l.IconLocation = '${exe},0'
      $l.Description = 'Kiln miner'
      $l.Save()
    }`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  console.log('Shortcuts added to Desktop and Start Menu');
})().catch((err) => { console.error(err); process.exit(1); });
