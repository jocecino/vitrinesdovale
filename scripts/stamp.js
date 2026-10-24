// Roda no deploy da Vercel: carimba a versão no index.html e no sw.js (sem isso, o site continua funcionando).
const fs = require('fs');
try {
  const v = String(process.env.VERCEL_GIT_COMMIT_SHA || Date.now()).slice(0, 8);
  for (const f of ['index.html', 'sw.js']) {
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.split('__V__').join(v));
  }
  console.log('versao', v);
} catch (e) { console.log('stamp ignorado:', e.message); }
