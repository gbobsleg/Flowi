'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildFixiLoader, REDACT_KEYS } = require('../dist/lib/fixiLoader');

/** Exécute le script généré dans un faux navigateur et renvoie les balises ajoutées au <head>. */
function runLoader(script) {
  const appended = [];
  const makeElement = (tag) => {
    const attrs = {};
    return {
      tag,
      attrs,
      src: '',
      setAttribute(name, value) { attrs[name] = String(value); },
      removeAttribute(name) { delete attrs[name]; },
    };
  };
  const window = {};
  const document = {
    createElement: makeElement,
    head: { appendChild(el) { appended.push(el); } },
  };
  vm.runInNewContext(script, { window, document });
  return { window, appended };
}

const CONFIG = {
  widgetUrl: 'https://fixi.example/widget.js',
  apiKey: 'cle-123',
  version: '1.1.0',
};

describe('buildFixiLoader', () => {
  it('sans configuration : fixiSetUser existe, aucune balise créée', () => {
    for (const cfg of [
      { widgetUrl: '', apiKey: '', version: '1.1.0' },
      { widgetUrl: CONFIG.widgetUrl, apiKey: '  ', version: '1.1.0' },
      { widgetUrl: '', apiKey: 'cle', version: '1.1.0' },
    ]) {
      const { window, appended } = runLoader(buildFixiLoader(cfg));
      assert.equal(typeof window.fixiSetUser, 'function');
      assert.doesNotThrow(() => window.fixiSetUser('Jean Dupont'));
      assert.equal(appended.length, 0);
    }
  });

  it('avec configuration : crée la balise du widget avec ses attributs', () => {
    const { appended } = runLoader(buildFixiLoader(CONFIG));
    assert.equal(appended.length, 1);
    const tag = appended[0];
    assert.equal(tag.src, CONFIG.widgetUrl);
    assert.equal(tag.attrs['data-app'], 'flowi');
    assert.equal(tag.attrs['data-api-key'], 'cle-123');
    assert.equal(tag.attrs['data-version'], '1.1.0');
    assert.equal(tag.attrs['data-redact-keys'], 'query,agent_matricule,matricule,nom,prenom');
    assert.equal(tag.attrs['data-redact-keys'], REDACT_KEYS);
  });

  it('fixiSetUser pose puis retire data-user', () => {
    const { window, appended } = runLoader(buildFixiLoader(CONFIG));
    window.fixiSetUser('Jean Dupont (A001)');
    assert.equal(appended[0].attrs['data-user'], 'Jean Dupont (A001)');
    window.fixiSetUser('');
    assert.equal('data-user' in appended[0].attrs, false);
  });

  it('échappement : une valeur hostile reste une chaîne et ne ferme pas le script', () => {
    const hostile = '"</script><script>alert(1)//';
    const script = buildFixiLoader({ ...CONFIG, apiKey: hostile });
    assert.equal(/<\/script/i.test(script), false);
    const { appended } = runLoader(script);
    assert.equal(appended[0].attrs['data-api-key'], hostile);
  });
});
