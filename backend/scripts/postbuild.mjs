/**
 * Post-build script
 *
 * Some deploy targets start the app via `node dist/server.js`.
 * Our TypeScript build outputs `dist/src/server.js`, so we generate
 * a tiny wrapper at `dist/server.js` for compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
const serverWrapper = path.join(distDir, 'server.js');
const compiledServer = path.join(distDir, 'src', 'server.js');

try {
	if (!fs.existsSync(distDir)) {
		console.log('⚠️ postbuild: dist/ missing, skipping wrapper creation');
	} else if (!fs.existsSync(serverWrapper) && fs.existsSync(compiledServer)) {
		fs.writeFileSync(serverWrapper, "import './src/server.js';\n", 'utf8');
		console.log('✅ postbuild: wrote dist/server.js wrapper');
	} else {
		console.log('✅ postbuild: no wrapper needed');
	}
} catch (err) {
	console.log('⚠️ postbuild: failed to create dist/server.js wrapper:', err?.message || err);
}

console.log('✅ Build complete!');
