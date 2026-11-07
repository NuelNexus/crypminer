// Builds a zip of the desktop app for a GitHub Release: dist\Kiln-<version>-win32-x64.zip
// Builds in its own folder, so it works while Kiln is running.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mod = require('@electron/packager');
const packager = mod.packager || mod.default || mod;

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const { version } = require('../package.json');

(async () => {
  require('./make-icons.js');
  const work = path.join(ROOT, 'dist-release');
  fs.rmSync(work, { recursive: true, force: true });
  const [builtDir] = await packager({
    dir: APP,
    out: work,
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

  const zip = path.join(ROOT, 'dist', `Kiln-${version}-win32-x64.zip`);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.rmSync(zip, { force: true });
  // Windows' built-in tar writes zip files when the name ends in .zip.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // not Git's GNU tar
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', path.dirname(builtDir), path.basename(builtDir)], { stdio: 'inherit' });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Release zip: ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
})().catch((err) => { console.error(err); process.exit(1); });
