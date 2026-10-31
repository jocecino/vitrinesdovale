// Roda no deploy da Vercel: carimba a versão no index.html e no sw.js e compacta app.js/painel.js/app.css
// (sem isso, o site continua funcionando; os arquivos do repositório continuam legíveis).
const fs = require('fs');
try {
  const v = String(process.env.VERCEL_GIT_COMMIT_SHA || Date.now()).slice(0, 8);
  for (const f of ['index.html', 'sw.js', 'app.js']) {
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.split('__V__').join(v));
  }
  console.log('versao', v);
} catch (e) { console.log('stamp ignorado:', e.message); }
try {
  const esbuild = require('esbuild');
  for (const [f, loader] of [['app.js', 'js'], ['painel.js', 'js'], ['app.css', 'css']]) {
    const src = fs.readFileSync(f, 'utf8');
    const r = esbuild.transformSync(src, { loader, minify: true, legalComments: 'none', charset: 'utf8', target: loader === 'js' ? 'es2019' : undefined });
    if (r.code && r.code.length > src.length * 0.5) { fs.writeFileSync(f, r.code); console.log('compactado', f, src.length, '->', r.code.length); }
  }
} catch (e) { console.log('compactação ignorada:', e.message); }
