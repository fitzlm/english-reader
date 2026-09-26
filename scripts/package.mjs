// 打包：把插件运行需要的文件压成 dist/linguipro-reader-<版本>.zip（上架或分发用）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const out = path.join(root, 'dist', `linguipro-reader-${version}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, 'manifest.json', 'src', 'fonts', 'icons', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log(`打包完成：${path.relative(root, out)}`);
