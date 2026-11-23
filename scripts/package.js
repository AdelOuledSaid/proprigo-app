'use strict';
// Archive du code seul : npm run package  →  ../proprigo-code-<version>.zip
// Utilise « git archive » : seuls les fichiers suivis par Git sont inclus, jamais data/, .env ni node_modules.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
const leaks = tracked.filter((f) => /^data\/|\.db(-wal|-shm)?$|\.enc$|^\.env|outbox\/|backups\//.test(f));
if (leaks.length) {
  console.error('Des données privées sont suivies par Git, archive refusée :\n  ' + leaks.join('\n  '));
  console.error('Retirez-les avec : git rm -r --cached data   puis faites un commit.');
  process.exit(1);
}
const out = path.join(root, '..', `proprigo-code-${version}.zip`);
execFileSync('git', ['archive', '--format=zip', `--output=${out}`, 'HEAD'], { cwd: root, stdio: 'inherit' });
console.log(`Archive créée sans données privées : ${out}`);
