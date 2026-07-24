#!/usr/bin/env node
/**
 * APEX Scalp build script.
 *
 * src/*.js dosyalarini dosya adina gore (01-, 02-, ... siraliyor) birlestirir,
 * template.html icindeki BUILD:INJECT_SCRIPT isaretcisinin yerine koyar,
 * sonucu index.html olarak yazar.
 *
 * Local calistirma:  node build.js
 * (Node.js disinda hicbir bagimlilik yok, npm install bile gerekmez.)
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const TEMPLATE_PATH = path.join(ROOT, 'template.html');
const OUTPUT_PATH = path.join(ROOT, 'index.html');
const MARKER = '/*BUILD:INJECT_SCRIPT*/';

function main() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('HATA: template.html bulunamadi: ' + TEMPLATE_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(SRC_DIR)) {
    console.error('HATA: src/ klasoru bulunamadi: ' + SRC_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.js'))
    .sort(); // "01-...", "02-..." on-ek sayesinde dogru sirada

  if (!files.length) {
    console.error('HATA: src/ icinde .js dosyasi yok');
    process.exit(1);
  }

  console.log('Birlestirilen dosyalar (sira ile):');
  const parts = [];
  for (const f of files) {
    console.log('  ' + f);
    const content = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    parts.push('/* ---- ' + f + ' ---- */\n' + content.trimEnd());
  }
  const combinedJs = parts.join('\n\n');

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!template.includes(MARKER)) {
    console.error('HATA: template.html icinde ' + MARKER + ' isaretcisi bulunamadi');
    process.exit(1);
  }
  // ONEMLI: template.replace(MARKER, combinedJs) KULLANMAYIN.
  // String.replace()'in 2. parametresi $', $&, $$ gibi dizileri ozel
  // regex-replacement kalibi olarak yorumlar. combinedJs icinde ' SL$'
  // gibi JS string literal'lari (ornegin logPos icindeki ok isareti +
  // dolar birlesimi) bu kaliplarla eslesip ciktinin sessizce bozulmasina
  // yol aciyordu. Fonksiyon-tabanli replacer bu ozel yorumlamayi devre
  // disi birakir ve combinedJs'i oldugu gibi, harfiyen ekler.
  const output = template.replace(MARKER, function() { return combinedJs; });

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
  console.log('\nOK: ' + OUTPUT_PATH + ' yazildi (' + files.length + ' dosya, ' +
    combinedJs.split('\n').length + ' satir JS)');
}

main();
